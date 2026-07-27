# Host Integration Capability Matrix

This document is the maintainer-facing source of truth for the `hostIntegration` block in every
`capabilities/<cli>/capability.json` runtime descriptor. Every per-CLI axis value is either:

- **documented** — backed by a cited authoritative source and evidence quote, or
- **`undocumented`** — the explicit fail-closed sentinel used when the CLI's public documentation
  does not state a value for that axis. `undocumented` validates in the registry but never
  propagates into effective axes: negotiation degrades closed to the safe default.

Values are generated from per-CLI documentation research (Context7 + official docs). They are
consumed verbatim by `gen:capability-registry` and validated by `capability-validator.cjs`.

---

## Axes legend

| Axis | Meaning |
|---|---|
| `embeddingMode` | Whether the CLI exposes an in-process programmatic API (`imperative`) or integrates purely through configuration files (`declarative`). |
| `commandSurface` | How slash commands are registered: `slash-file` (markdown), `slash-toml` (TOML), `slash-programmatic` (code API), `palette`, `prose-only`. |
| `modelMode` | Whether extensions can programmatically request or supply a model (`active`) or select only by config (`passive`). |
| `hookBus` | Who owns the hook lifecycle: `host` (the CLI fires hooks), `engine` (VS Code/Electron extension host), `none`. |
| `stateIO` | Filesystem access model: `filesystem` (full local FS), `sandboxed-storage`, `session-log-append`. |
| `transport` | Integration transport: `mcp` (Model Context Protocol), `native-extension`. |
| `runtime` | Plugin/extension execution runtime: `node`, `bun`, `python`, `go`, `rust`, `electron`, `sandboxed-web`, `other`. |

### dispatch sub-axes

| Sub-axis | Meaning |
|---|---|
| `namedDispatch` | Whether agents can be invoked by name (true/false/`undocumented`). |
| `nested` | Whether subagents can themselves spawn subagents (true/false/`undocumented`). |
| `maxDepth` | Maximum nesting depth (integer; -1 = unbounded; `undocumented`). |
| `background` | Whether subagents can run asynchronously in the background (true/false/`undocumented`). |
| `subagentToolkit` | Tool surface available to subagents: `full`, `read-only`, or `undocumented`. |
| `backgroundDispatch` | Whether a BACKGROUND-dispatched sub-agent can itself spawn further named sub-agents — the #853 discriminator (true/false/`undocumented`). |

### Interface points

| Point | Meaning |
|---|---|
| `command` | Slash-command routing and invocation capability. |
| `dispatch` | Subagent/multi-agent dispatch capability. |
| `model` | Programmatic model selection capability. |
| `hooks` | Lifecycle hook registration capability. |
| `state` | Filesystem/state I/O capability. |
| `artifact` | Artifact delivery (skills, commands) surface capability. |

---

## claude

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://code.claude.com/docs/en/agent-sdk/overview | "The Agent SDK offers hooks to execute custom code at critical points within the agent's lifecycle. These callback functions enable developer" |
| commandSurface | slash-file | https://code.claude.com/docs/en/agent-sdk/slash-commands | "Each custom command is a markdown file where the filename (without the `.md` extension) becomes the command name. The file content defines w" |
| modelMode | passive | https://code.claude.com/docs/en/agent-sdk/typescript | "setModel(model?: string): Changes the model (only available in streaming input mode) ... model overrides the default model for this subagent" |
| hookBus | host | https://code.claude.com/docs/en/agent-sdk/python | "HookEvent = Literal['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreCompact', 'Notificati" |
| stateIO | filesystem | https://code.claude.com/docs/en/sandboxing | "The sandboxed Bash tool restricts file system access, granting read and write access to the current working directory and session temp direc" |
| transport | mcp | https://code.claude.com/docs/en/mcp | "Project-Scoped MCP Server Configuration in .mcp.json ... This JSON structure illustrates the format for a project-scoped MCP server configur" |
| runtime | node | https://code.claude.com/docs/en/agent-sdk/typescript | "import { query } from \"@anthropic-ai/claude-agent-sdk\"; ... pathToClaudeCodeExecutable (string) - Specifies the path to the Claude Code CLI" |
| dispatch.namedDispatch | true | https://code.claude.com/docs/en/agent-sdk/subagents | "agents: { 'code-reviewer': AgentDefinition({ description: 'Expert code reviewer.', ... }) } ... subagent_type: block.inp" |
| dispatch.nested | true | https://code.claude.com/docs/en/sub-agents | "As of Claude Code v2.1.172, a subagent can spawn its own subagents, allowing delegated tasks to split into parallel subt" |
| dispatch.maxDepth | 5 | https://code.claude.com/docs/en/sub-agents | "foreground subagents can spawn at any depth, blocking their parent until completion. Background subagents are limited to" |
| dispatch.background | true | https://code.claude.com/docs/en/sub-agents | "Subagents can run in the foreground, blocking the main conversation and passing permission prompts to you, or in the bac" |
| dispatch.subagentToolkit | full | https://code.claude.com/docs/en/sub-agents | "If all tools remain selected, the subagent inherits all tools available to the main conversation." |
| dispatch.backgroundDispatch | false | https://code.claude.com/docs/en/sub-agents | "Background subagents are limited to a depth of five and cannot spawn further, " |
| dispatch.isolation | harness-worktree | https://code.claude.com/docs/en/sub-agents ; Claude Code Agent tool (`Agent(isolation="worktree")`) | The Claude Code Agent tool accepts an `isolation="worktree"` harness primitive — the host's own harness creates + binds a git worktree per executor; GSD passes the flag and calls no git itself (#2584) |

Sources consulted:
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/agent-sdk/slash-commands
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/python
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/sandboxing
- Context7 /websites/code_claude
- Context7 /llmstxt/code_claude_llms_txt

---

## codex

> **Note:** ADR-1239's host matrix lists Codex as `prose-only`; current OpenAI Codex dev docs document slash-commands, so `commandSurface` is `slash-file` here (docs are the source of truth).

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://developers.openai.com/codex/plugins/build | "No in-process programmatic API exists. Plugins integrate through: External command execution (hooks), MCP server processes, Configuration fi" |
| commandSurface | slash-file | https://github.com/openai/codex/blob/main/codex-rs/core-skills/src/loader.rs | "const SKILLS_FILENAME: &str = \"SKILL.md\"; ... Each skill is a folder with a SKILL.md file containing YAML frontmatter with name and descript" |
| modelMode | passive | https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs | "pub model_provider: Option<String> ... model is selected by config field; no programmatic model request API" |
| hookBus | host | https://github.com/openai/codex/blob/main/codex/codex-rs/hooks/src/lib.rs | "pub const HOOK_EVENT_NAMES: [&str; 10] = [\"PreToolUse\", \"PermissionRequest\", \"PostToolUse\", \"PreCompact\", \"PostCompact\", \"SessionStart\", \"Us" |
| stateIO | filesystem | https://developers.openai.com/codex/concepts/sandboxing | "workspace-write: The default mode allowing Codex to read files, edit within the workspace, and run routine local commands inside that bounda" |
| transport | mcp | https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs | "pub mcp_servers: HashMap<String, McpServerConfig> ... Definition for MCP servers that Codex can reach out to for tool calls." |
| runtime | node | https://github.com/openai/codex/blob/main/codex-cli/package.json | "\"engines\": {\"node\": \">=16\"} ... The npm-distributed CLI wrapper is a Node.js script (#!/usr/bin/env node)" |
| dispatch.namedDispatch | true | https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs | "\"agent_type\".to_string(), JsonSchema::string(Some(agent_type_description.to_string())) ... apply_role_to_config(&mut con" |
| dispatch.nested | true | https://developers.openai.com/codex/multi-agent | "agents.max_depth defaults to 1, which allows a direct child agent to spawn but prevents deeper nesting." |
| dispatch.maxDepth | 1 | https://developers.openai.com/codex/config-reference | "agents.max_depth: Maximum nesting depth allowed for spawned agent threads (root sessions start at depth 0; default: 1)" |
| dispatch.background | true | https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs | "spawn_agent returns the spawned agent id immediately; a separate wait_agent tool polls for final status." |
| dispatch.subagentToolkit | full | https://developers.openai.com/codex/multi-agent | "Subagents inherit the sandbox policy and tool surface from the parent session." |
| dispatch.backgroundDispatch | true | https://github.com/openai/codex/blob/main/codex-rs/core/templates/collab/experimental_prompt.md | "Sub-agents have access to the same set of tools as you do so you must tell them if they are allowed to spawn sub-agents themselves or not." The config (codex-rs/config/src/config_toml.rs) exposes an |
| dispatch.isolation | orchestrator-worktree | https://learn.chatgpt.com/docs/environments/git-worktrees ; https://github.com/openai/codex/blob/main/codex-rs/utils/cli/src/shared_options.rs | "Worktrees are available only in Codex in the ChatGPT desktop app." (no native CLI worktree) + `codex exec --cd <dir>` sets an explicit working root, so GSD creates+manages the worktree and points the executor at it (#2584) |

**GSD integration status — Phase D dogfood complete (#2088, ADR-1239).** Codex installs through the `declarative` embedding adapter (`createDeclarativeAdapter` → `installRuntimeArtifacts`); the hardcoded `runtime === 'codex'`/`isCodex` projection is folded into descriptor-driven `runtime.hostBehaviors`, and install/uninstall output is byte-parity-gated (`tests/fixtures/golden-install-parity/codex.json`). Three capability upgrades land, each with a test driving the user-reachable surface:

- **Skill root** — skills install to the canonical `$HOME/.agents/skills` (Codex core-skills `loader.rs` user-scope root), not the deprecated `$CODEX_HOME/skills` fallback. Declared via the skills-kind `home: ".agents"` override; pre-move installs are migrated (stale `~/.codex/skills/gsd-*` cleaned on both install and uninstall).
- **Hook events** — GSD registers all documented `hooks.json` lifecycle events beyond `SessionStart`: `SubagentStart`, `Stop`, `PostToolUse` (#772), plus the six added in #2088 — `PreToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStop`, `UserPromptSubmit` — all routed through `gsd-context-monitor.js`. (The descriptor `extendedHookEvents` field reflects the schema-valid cross-runtime subset `SubagentStop`/`Stop`/`PreCompact`; Codex's full event set is codex-hooks-json-native, registered directly in `hooks.json`.)
- **Dispatch tuning** — `[agents] max_depth = 1` is written explicitly into the managed `config.toml` block, pinning the `dispatch.maxDepth: 1` axis instead of relying on codex-cli's implicit default. Because `maxDepth === 1`, `degradationFor` flattens GSD-hosted wave dispatch to single-level even though `dispatch.nested`/`background`/`backgroundDispatch` are all `true`. The block is a bare `[agents]` AgentsToml scalar table; it does **not** carry per-role `[agents.gsd-*]` sub-tables — those pointed `config_file` back at the standalone `agents/gsd-*.toml` files Codex already auto-discovers, so emitting them was a duplicate role registration (Codex logged "Ignoring malformed agent role definition: duplicate agent role name" once per agent) removed in #2406. `validateCodexConfigSchema` permits a known-scalar-only `[agents]` while still rejecting `[[agents]]` and unknown-key forms.

Sources consulted:
- https://github.com/openai/codex (repo via gh CLI)
- /openai/codex (Context7 library ID)
- https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs
- https://github.com/openai/codex/blob/main/codex-rs/core-skills/src/loader.rs
- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/plugins/build
- https://developers.openai.com/codex/multi-agent
- https://developers.openai.com/codex/cli/slash-commands

Documentation gaps:
- dispatch.maxDepth is configurable (Option<i32> with no documented upper bound); the documented default is 1 but the actual enforced maximum is not stated.
- dispatch.subagentToolkit: docs say subagents 'inherit the tool surface' but do not enumerate whether any tools are excluded.
- runtime: the Node.js entry point is a thin launcher shim; the actual agent execution runtime is a compiled Rust binary — axis classification is ambiguous.

---


## opencode

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://opencode.ai/docs/plugins | "Plugins are JavaScript/TypeScript modules that export plugin functions; they register hooks via `import type { Plugin } from '@opencode-ai/p'" |
| commandSurface | slash-file | https://opencode.ai/docs/commands | "\"Create markdown files in the `commands/` directory to define custom commands.\" and \"The markdown file name becomes the command name." |
| modelMode | active | /anomalyco/opencode (Context7) — packages/plugin/src/v2/promise/README.md | "`ctx.aisdk.sdk(async (event) => { ... event.sdk = mod.createXai(event.options) })` and `ctx.aisdk.language((event) => { ... event.language =" |
| hookBus | host | https://opencode.ai/docs/plugins | "Host fires events including: `tool.execute.before`, `tool.execute.after`, `session.created`, `session.compacted`, `session.deleted`" |
| stateIO | filesystem | https://opencode.ai/docs/plugins | "Plugin context includes `directory` (working directory path), `worktree` (git worktree path), and `$` (\"Bun's shell API\")" |
| transport | mcp | https://opencode.ai/docs/mcp-servers | "\"OpenCode supports both local and remote servers.\" and \"Once added, MCP tools are automatically available to the LLM\"" |
| runtime | bun | https://opencode.ai/docs/plugins | "\"$\": Bun's shell API for executing commands\" (plugin context property); \"OpenCode runs `bun install` at startup\"" |
| dispatch.namedDispatch | true | https://opencode.ai/docs/agents | "\"Subagents can be invoked: Automatically by primary agents for specialized tasks based on their descriptions. Manually b" |
| dispatch.nested | undocumented | no authoritative doc — searched: https://opencode.ai/docs/agents | — |
| dispatch.maxDepth | undocumented | no authoritative doc — searched: https://opencode.ai/docs/agents | — |
| dispatch.background | false | https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/effect/runtime-flags.ts ; https://github.com/anomalyco/opencode/issues/29638 | "`experimentalBackgroundSubagents: enabledByExperimental(\"OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS\")` — `enabledByExperimental` falls back to the `experimental` flag, and `bool()` defaults to `false`, so the Task tool's `background` parameter is hidden from the model unless the operator opts in by env var. #29638 (OPEN) confirms the session loop still `tasks.pop()`s one subtask at a time. (#2598 — corrects #2087, whose \"v1.17 default-on in all modes\" reading does not hold against current `dev`)" |
| dispatch.subagentToolkit | full | https://opencode.ai/docs/agents | "The 'general' subagent \"Has full tool access (except todo), so it can make file changes when needed.\"" |
| dispatch.backgroundDispatch | false | https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/effect/runtime-flags.ts ; https://github.com/anomalyco/opencode/issues/29638 ; https://github.com/anomalyco/opencode/issues/14195 | "Concurrent dispatch requires the opt-in `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` flag (default `false`), so it cannot be relied on. #14195: \"the session loop does `tasks.pop()` to grab a single subtask, `await`s it, then `continue`s the loop — so even 3 simultaneous Task calls run sequentially.\" Declaring `true` would overstate the capability, against the fail-closed posture negotiation is built for. (#2598 — corrects #2087)" |
| dispatch.isolation | orchestrator-worktree | https://opencode.ai/docs/cli ; opencode.ai/docs/plugins ; opencode issues #14195/#29638/#5887 | "`opencode run --dir <path>` sets an explicit working root at the process level" — native subagent dispatch is synchronous-only, so GSD creates + manages the worktree and process-spawns the executor into it via `--dir` (#2584) |

Sources consulted:
- https://opencode.ai/docs/plugins
- https://opencode.ai/docs/agents
- https://opencode.ai/docs/commands
- https://opencode.ai/docs/mcp-servers
- /websites/opencode_ai_plugins (Context7)
- /anomalyco/opencode (Context7)
- https://github.com/sst/opencode/issues/5887

Documentation gaps:
- dispatch.nested
- dispatch.maxDepth

---

## cursor

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://cursor.com/docs/sdk/typescript | "local.customTools where you define tool functions that execute 'in your process, so it can reach anything your code can'; Agent.create()" |
| commandSurface | slash-file | https://cursor.com/docs/enterprise/llm-safety-and-controls | "Commands are reusable prompts invoked via slash commands (e.g., /test), while workflows enable multi-step processes" |
| modelMode | passive | https://cursor.com/docs/sdk/python | "The model used for a run can be overridden by passing a ModelSelection object in SendOptions to agent.send()." |
| hookBus | host | https://cursor.com/docs/hooks | "Agent hooks: sessionStart, sessionEnd, preToolUse, postToolUse, subagentStart, subagentStop, beforeShellExecution, afterShellExecution" |
| stateIO | filesystem | https://cursor.com/docs/reference/sandbox | "Local agents run with sandbox options disabled by default." |
| transport | mcp | https://cursor.com/docs/mcp | "The Model Context Protocol (MCP) allows Cursor to connect to external tools and data sources." |
| runtime | node | https://cursor.com/docs/sdk/typescript | "The SDK runs on Node.js. It requires Node.js 22.13 or later and is described as a Node-first package." |
| dispatch.namedDispatch | true | https://cursor.com/docs/subagents | "Invoke specific subagents using slash commands in your prompt. This allows for direct control over which agent performs" |
| dispatch.nested | true | https://cursor.com/docs/sdk/typescript | "The top-level agent and its direct subagents can launch subagents, but a subagent launched by another subagent can't lau" |
| dispatch.maxDepth | 2 | https://cursor.com/docs/sdk/typescript | "The top-level agent and its direct subagents can launch subagents, but a subagent launched by another subagent can't lau" |
| dispatch.background | true | https://cursor.com/docs/subagents | "Background, which returns immediately while the subagent works independently, best for long-running tasks or parallel wo" |
| dispatch.subagentToolkit | full | https://cursor.com/docs/subagents | "Subagents can utilize MCP tools, inheriting all tools available to their parent agent, including those from configured s" |
| dispatch.backgroundDispatch | true | https://cursor.com/docs/subagents (FAQ: Can subagents launch other subagents?) and https://cursor.com/docs/sdk/typescript (Subagents > Nested subagents) | FAQ: "As of Cursor 2.5, subagents have the capability to launch child subagents, enabling the creation of a hierarchical structure for coordinated tasks. This nested launching functionality requires T |
| dispatch.isolation | harness-worktree | https://cursor.com/docs/cli/reference/parameters ; cursor.com/docs/cli/using ; cursor.com/docs/cli/changelog | "`-w, --worktree [name]` — cursor-agent creates/binds a git worktree per agent (`~/.cursor/worktrees/…`); native parallel-agent dispatch" (#2584) |

Sources consulted:
- https://cursor.com/docs/subagents
- https://cursor.com/docs/hooks
- https://cursor.com/docs/sdk/typescript
- https://cursor.com/docs/sdk/python
- https://cursor.com/docs/mcp
- https://cursor.com/docs/reference/sandbox
- https://cursor.com/docs/enterprise/llm-safety-and-controls
- /websites/cursor (Context7)

**GSD integration status — Phase D dogfood complete (#2089, ADR-1239).** Cursor installs through the `imperative` embedding adapter (`createImperativeAdapter` → `installRuntimeArtifacts`); the hardcoded `runtime === 'cursor'` / `isCursor` projection is folded into descriptor-driven `runtime.hostBehaviors`, and install/uninstall output is byte-parity-gated (`tests/fixtures/golden-install-parity/cursor.json`). Two capability upgrades land, each with a test driving the user-reachable surface:

- **Expanded hook-bus coverage** — GSD registers all 6 managed lifecycle events in `hooks.json` beyond the original `sessionStart`/`postToolUse`: `preToolUse`, `stop`, `subagentStart`, `subagentStop` (AC4a, cite https://cursor.com/docs/hooks). The hook-bus binding is descriptor-driven via `src/host-integration-adapters/imperative-hook-bus.cts` (reads `hostBehaviors.managedHookEvents`), not a hardcoded event pair.
- **Named/background nested subagent dispatch** — `dispatch.background`/`backgroundDispatch`/`nested` are all `true` with `maxDepth: 2`; `shouldFlattenDispatch(cursor)` returns `false` so GSD's wave-based execution drives Cursor's native background + depth-2 nested subagent dispatch instead of flattening to inline sequential calls (AC4b, cite https://cursor.com/docs/subagents + https://cursor.com/docs/sdk/typescript).

---

## cline

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/sdk/plugins.mdx | "Implement the AgentPlugin interface to register tools, hooks, and configuration. The setup function is used for registering capabilities." |
| commandSurface | slash-file | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/cline/apps/vscode/src/test/slash-commands.test.ts | "workflow markdown files (with .md, .markdown, or .txt extensions) are invoked as slash commands using their filename." |
| modelMode | active | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/sdk/packages/llms/README.md | "The Runtime API, accessible via createLlmsRuntime(...), allows for the creation of a registry that manages configured providers and their de" |
| hookBus | host | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/sdk/README.md | "Package agent capabilities as extensions (plugins) that can register tools, observe lifecycle events, and modify agent behavior." |
| stateIO | filesystem | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/cline/sdk/packages/shared/src/storage/paths.ts | "resolveClineDir() returns ~/.cline; resolveDocumentsExtensionPath('Workflows') returns ~/Documents/Cline/Workflows." |
| transport | mcp | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx | "MCP (Model Context Protocol) enables Cline to interact with external tools and data sources" |
| runtime | node | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/sdk/examples/plugins/typescript-lsp/README.md | "Installs a portable subagent plugin ... cp examples/plugins/agents-squad/index.ts ~/.cline/plugins/portable-subagents.ts." |
| dispatch.namedDispatch | true | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/sdk/examples/plugins/agents-squad/README.md | "parent → start_subagent(preset: \"phantom\", task: \"Map the auth module\") → phantom: save_handoff(...)" |
| dispatch.nested | false | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/features/subagents.mdx | "subagents are restricted from editing files, using the browser, accessing MCP servers, or creating nested subagents." |
| dispatch.maxDepth | 1 | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/features/subagents.mdx | "They are explicitly prohibited from ... spawning other subagents." |
| dispatch.background | true | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/features/subagents.mdx | "Commands executed by subagents run in the background and are strictly limited to read-only operations" |
| dispatch.subagentToolkit | read-only | /cline/cline (Context7) — https://github.com/cline/cline/blob/main/docs/features/subagents.mdx | "Subagents are equipped with tools for read-only operations, including reading file contents (read_file), listing directo" |
| dispatch.backgroundDispatch | false | https://docs.cline.bot/features/subagents (mirrored at https://github.com/cline/cline/blob/main/docs/features/subagents.mdx) | "They cannot edit files, use the browser, or spawn nested subagents" — and from the GitHub source: "subagents are restricted from editing files, using the browser, accessing MCP servers, or creating n |
| dispatch.isolation | undocumented | not researched / no concurrent fan-out documented for this axis | no authoritative source consulted for concurrent-executor isolation on this host — fails closed to `none` (sequential) in negotiation (#2584) |

Sources consulted:
- https://github.com/cline/cline/blob/main/docs/sdk/plugins.mdx
- https://github.com/cline/cline/blob/main/sdk/README.md
- https://github.com/cline/cline/blob/main/sdk/packages/agents/README.md
- https://github.com/cline/cline/blob/main/sdk/examples/plugins/agents-squad/README.md
- https://github.com/cline/cline/blob/main/docs/features/subagents.mdx
- https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx
- https://github.com/cline/cline/blob/main/sdk/packages/llms/README.md
- /cline/cline (Context7)

**GSD integration status — Phase D dogfood complete (#2090, ADR-1239).** Cline installs through the `imperative` embedding adapter (`createImperativeAdapter` → `installRuntimeArtifacts`); the hardcoded `runtime === 'cline'` / `isCline` projection is folded into descriptor-driven `runtime.hostBehaviors`, and install/uninstall output is byte-parity-gated (`tests/fixtures/golden-install-parity/cline.json`). Two capability upgrades land, each with a test driving the user-reachable surface:

- **`AgentPlugin.hooks.beforeTool` planning guard** — the `.clinerules/hooks/PreToolUse` file-convention hook (#787) is re-implemented as a real Cline SDK `AgentPlugin` registered through the negotiated `hookBus: host` interface point. Guard semantics are preserved exactly (fail-open, cancels write-class calls targeting `.planning/`); the SDK maps the file hook's `{cancel, errorMessage}` to `{skip, reason}`. The binding lives in `src/host-integration-adapters/cline-sdk-binding.cts` (cite https://github.com/cline/cline/blob/main/docs/sdk/plugins.mdx).
- **`createAgentModel` per-subagent model overrides** — `DefaultGateway.createAgentModel({providerId, modelId})` is wired so GSD's `model_overrides` / `model_profile_overrides` resolution (already used for OpenCode/Codex passive hosts) applies to cline subagents (`modelMode: active`), instead of leaving model selection untouched (cite https://github.com/cline/cline/blob/main/docs/sdk/reference/gateway.mdx).
- **Dispatch stays degraded/flat (deliberate)** — unlike cursor's dispatch upgrade, cline's `dispatch` is `maxDepth: 1`, `nested: false`, `subagentToolkit: 'read-only'`, `backgroundDispatch: false`. `shouldFlattenDispatch(cline)` returns `true` and `degradationFor('dispatch', cline)` returns `{level:'degraded', fallback:'flat dispatch — waves run inline'}`. This is NOT upgraded: cline's own docs restrict subagents to a single level with a read-only toolkit and no nested spawning, so claiming full dispatch would misrepresent the host and violate the fail-closed negotiation contract (cite https://github.com/cline/cline/blob/main/docs/features/subagents.mdx).

---

## hermes

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin | "ctx.register_tool() puts your tool in the registry — the model sees it immediately" |
| commandSurface | slash-programmatic | https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin | "ctx.register_command('mystatus', handler=_handle_status, description='Show plugin status') — The command appears in autocomplete, /help output" |
| modelMode | active | https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin | "register_provider(ProviderProfile(name=..., aliases=(...), display_name=..., env_vars=(...), base_url=..., auth_type=..., default_aux_model=" |
| hookBus | host | https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks | "Hermes owns and manages the entire hook infrastructure. At runtime, HookRegistry.discover_and_load() scans ~/.hermes/hooks/" |
| stateIO | filesystem | https://hermes-agent.nousresearch.com/docs/user-guide/configuration | "The agent has the same filesystem access as your user account." |
| transport | mcp | https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp | "MCP support ships with the standard install — no extra step needed." |
| runtime | python | Context7 /nousresearch/hermes-agent | "The plugin and agent runtime is Python (confirmed by register(ctx) in __init__.py, importlib.import_module, run_agent.py, tools/registry.py)" |
| dispatch.namedDispatch | false | https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation | "The documentation contains no mention of named agents. Subagents are identified only by role ('leaf' or 'orchestrator')" |
| dispatch.nested | true | /nousresearch/hermes-agent (Context7) — configuration.md | "max_spawn_depth: 1 — Delegation tree depth cap (1-3, clamped). 1 = flat (default): parent spawns leaves that cannot dele" |
| dispatch.maxDepth | 1 | /nousresearch/hermes-agent (Context7) — configuration.md | "max_spawn_depth: 1 # Delegation tree depth cap (1-3, clamped). 1 = flat (default): parent spawns leaves that cannot dele" |
| dispatch.background | true | https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.19 | "delegate_task(background=true) dispatches a subagent that runs in the background and returns a handle immediately" |
| dispatch.subagentToolkit | read-only | https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns | "Nested delegation is opt-in; by default, leaf subagents cannot call delegate_task, clarify, memory, send_message, or exe" |
| dispatch.backgroundDispatch | false | https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/delegation.md (via Context7 query of /nousresearch/hermes-agent) | "Nested delegation is an opt-in feature, requiring role=\"orchestrator\" for children and an increased max_spawn_depth from its default of 1. It can also be globally disabled with orchestrator_enabled |
| dispatch.isolation | undocumented | not researched / no concurrent fan-out documented for this axis | no authoritative source consulted for concurrent-executor isolation on this host — fails closed to `none` (sequential) in negotiation (#2584) |

Sources consulted:
- https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks
- https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin
- https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns
- https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.19
- /nousresearch/hermes-agent (Context7)

**EoS migration status (#2091):** Migrated onto the imperative adapter. All `runtime === 'hermes'` branches in `bin/install.js` folded into descriptor-driven `runtime.hostBehaviors`. New `extensionEvents: "hermes"` dialect registered (13 real plugin hook events, replacing the borrowed `hookEvents: "claude"` 6-event surface). Cite: https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md

Documentation gaps:
- runtime — Hermes plugins and agent core run in Python, but this was confirmed by code inspection rather than explicit docs statement.
- dispatch.namedDispatch — docs explicitly confirm no named-agent dispatch in delegate_task; Kanban has named profiles but that is a separate board system not a dispatch mechanism.

---

## antigravity

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://github.com/alphaperseii3000/google-antigravity-docs/blob/master/google-antigravity-docs.md | "Skills require a SKILL.md file; Workflows are saved as markdown files; Rules are manually defined constraints — all configuration-file-based" |
| commandSurface | slash-file | https://github.com/alphaperseii3000/google-antigravity-docs/blob/master/google-antigravity-docs.md | "Workflows are saved as markdown files, providing a repeatable method for executing key processes. They can be invoked in the Agent using a s" |
| modelMode | passive | https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7 | "Selection occurs via `-m` flag or `/model` command inside the TUI. No programmatic model request API is documented for extensions/skills" |
| hookBus | host | https://www.aibuilderclub.com/blog/antigravity-cli-guide | "The CLI fires hooks, not the engine. These are JSON lifecycle interceptors (before tool call, after file edit, on session start)." |
| stateIO | filesystem | https://www.explainx.ai/blog/antigravity-cli-features-sandbox-plugins-subagents-2026 | "Plugin staging at ~/.gemini/antigravity-cli/plugins/<name>/; skills at ~/.gemini/antigravity-cli/skills/" |
| transport | mcp | https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7 | "Both local (stdio) and remote (HTTP) Model Context Protocol servers are supported" |
| runtime | go | https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ | "Built in Go, Antigravity CLI is snappier and more responsive." |
| dispatch.namedDispatch | undocumented | no authoritative doc — searched: https://www.aibuilderclub.com/blog/antigravity-cli-guide, https://antigravity.google/docs/agents | — |
| dispatch.nested | undocumented | no authoritative doc — searched: https://antigravity.google/docs/agents | — |
| dispatch.maxDepth | undocumented | no authoritative doc — searched: https://antigravity.google/docs/agents | — |
| dispatch.background | true | https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ | "Antigravity CLI orchestrates multiple agents for complex tasks in the background" |
| dispatch.subagentToolkit | full | https://antigravity.google/docs/cli/features | "Capabilities: Subagents have full access to tools such as code search, file editing, terminal commands, and web searches to complete their assigned tasks." (#2096 EoS migration — the page is JS-rendered/blank on a static fetch; confirmed via headless-browser render) |
| dispatch.backgroundDispatch | undocumented | no authoritative doc — Multiple sources consulted: antigravity.google/docs/cli-subagents (returned blank/JS-rendered), antigravity.google/docs/agent (blank), github.com/google-antigravity/antigravity-cli README, Context7 /google-antigravity/antigravity-cli | All documentation consulted describes a two-level orchestrator→subagent architecture. Background subagents run asynchronously while the main agent continues accepting prompts. The DataCamp tutorial st |
| dispatch.isolation | undocumented | not researched / no concurrent fan-out documented for this axis | no authoritative source consulted for concurrent-executor isolation on this host — fails closed to `none` (sequential) in negotiation (#2584) |

Sources consulted:
- https://github.com/alphaperseii3000/google-antigravity-docs/blob/master/google-antigravity-docs.md
- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7
- https://www.explainx.ai/blog/antigravity-cli-features-sandbox-plugins-subagents-2026
- https://www.aibuilderclub.com/blog/antigravity-cli-guide
- https://antigravity.google/docs/agents
- https://antigravity.google/docs/hooks
- https://antigravity.google/docs/cli/features (#2096 — subagentToolkit)

Documentation gaps:
- dispatch.namedDispatch — docs describe dynamic plain-English goal dispatch where agent names subagents at runtime; no pre-registered named sub-agent API documented.
- dispatch.nested — no documentation found on whether subagents can themselves spawn further subagents.
- dispatch.maxDepth — no documented depth limit or explicit unbounded statement found.

**EoS migration status (#2096):** Migrated onto the declarative adapter. All `runtime === 'antigravity'` / `isAntigravity` / `canonical === 'antigravity'` branches folded into descriptor-driven `runtime.hostBehaviors` + `runtime.hostIntegration`: `getConfigDirFromHome` (`bin/install.js`) now branches on `configHome.kind === 'dot-home-nested'` instead of a hardcoded runtime literal; `projectLocalHookPrefix` (`src/shell-command-projection.cts`) reads `hostBehaviors.hookPathStyle` (`'raw'` → bare `dirName`, no `$CLAUDE_PROJECT_DIR` anchor); `applyAgentPathRewrites` (`src/runtime-artifact-conversion.cts`) reads `hostBehaviors.noPathRewrite` to skip the `~/.claude/` → pathPrefix rewrites; and `getProjectInstructionFile` (`src/runtime-name-policy.cts`) reads `hostBehaviors.projectInstructionFile` (`"GEMINI.md"` — Antigravity CLI's `contextFileName`, successor to the sunset Gemini CLI per #1928) instead of a hardcoded `canonical === 'antigravity'` check. The dead `isAntigravity` branches these functions previously carried are removed. `dispatch.subagentToolkit` flipped `undocumented` → `full` per the citation above (antigravity.google/docs/cli/features); `dispatch.namedDispatch`/`nested`/`maxDepth`/`backgroundDispatch` stay `undocumented` — no authoritative source states named/nested/depth-bounded dispatch or a `run_in_background`-style call-time param, so `negotiateHostCapabilities` degrades all four closed to their most-restrictive value (false/0), and `shouldFlattenDispatch` still forces antigravity's dispatch to flatten (inline) despite `dispatch.background: true`, because `backgroundDispatch` itself never reaches `true`. Two upgrades land: **UPGRADE 1 — permission-writer** (`configureAntigravityPermissions`, `runtime.permissionWriter: "antigravity"`) writes Antigravity's native `{"permissions":{"allow":[...]}}` schema (antigravity.google/docs/cli/permissions) into the same `settings.json` GSD's own hook registration writes, granting GSD's own `read_file`/`command` rules non-destructively. **UPGRADE 2 — MCP companion config** (`configureAntigravityMcpConfig`) writes a standalone `mcp_config.json` (antigravity.google/docs/cli/gcli-migration) registering the `gsd` MCP server, non-destructively preserving any other `mcpServers` entries. Both upgrades are covered by `tests/antigravity-upgrades.test.cjs`; the axis/negotiation/source-grep coverage above is in `tests/declarative-reference-antigravity.test.cjs`.

---

## augment

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://docs.augmentcode.com/cli/plugins | "Plugins can provide several types of components, including Custom Commands defined in Markdown files within the `commands/` directory... Hoo" |
| commandSurface | slash-file | https://docs.augmentcode.com/cli/plugins | "Slash commands are Markdown files in the `commands/` directory. The filename becomes the command name" |
| modelMode | passive | https://docs.augmentcode.com/cli/subagents | "| model | No | Model to use for the agent. If not specified, the CLI default model is used." |
| hookBus | host | https://docs.augmentcode.com/cli/hooks | "Hook event types: PreToolUse (before a tool executes), PostToolUse (immediately after a tool completes), Stop (when the agent stops respondi" |
| stateIO | filesystem | https://github.com/augmentcode/auggie | "Node.js 22+ required. Hook configurations use `${AUGMENT_PLUGIN_ROOT}`" |
| transport | mcp | https://docs.augmentcode.com/cli/plugins | "Auggie supports a plugin system that allows you to extend its functionality with... MCP server integrations." |
| runtime | node | https://github.com/augmentcode/auggie | "Node.js 22+ required" |
| dispatch.namedDispatch | true | https://docs.augmentcode.com/cli/subagents | "| **name** | Yes | Name of the agent | ... you can trigger it by sending a message that references the agent name." |
| dispatch.nested | undocumented | no authoritative doc — searched: https://docs.augmentcode.com/cli/subagents | — |
| dispatch.maxDepth | undocumented | no authoritative doc — searched: https://docs.augmentcode.com/cli/subagents | — |
| dispatch.background | true | https://docs.augmentcode.com/cli/subagents | "Subagents run in parallel with other subagents... will show a summary of their current progress in the main thread." |
| dispatch.subagentToolkit | full | https://docs.augmentcode.com/cli/subagents | "If neither [tools nor disabled_tools] is specified, the subagent has access to all tools (default behavior)." |
| dispatch.backgroundDispatch | undocumented | no authoritative doc — https://docs.augmentcode.com/cosmos/automations | The Augment Code (Cosmos) docs describe workers as 'sub-agents launched mid-session by a manager Expert using the worker-launch command. Each worker is its own session with its own messages and permis |
| dispatch.isolation | undocumented | not researched / no concurrent fan-out documented for this axis | no authoritative source consulted for concurrent-executor isolation on this host — fails closed to `none` (sequential) in negotiation (#2584) |

Sources consulted:
- https://docs.augmentcode.com/cli/plugins
- https://docs.augmentcode.com/cli/hooks
- https://docs.augmentcode.com/cli/subagents
- https://docs.augmentcode.com/cli/sdk-typescript
- https://docs.augmentcode.com/setup-augment/mcp
- https://github.com/augmentcode/auggie
- /llmstxt/augmentcode_llms-full_txt (Context7)

Documentation gaps:
- dispatch.nested
- dispatch.maxDepth

**EoS migration status (#2097):** Folded onto descriptor-driven dispatch.
Augment already installed through the declarative adapter (nested-skill
artifact layout, `settings-json` hook surface, Claude hook event dialect), but
carried two remaining runtime-literal branches in
`src/runtime-artifact-conversion.cts`: the 4 `~/.augment`/`$HOME/.augment`
dot-dir rewrites in `_applyRuntimeRewrites`'s `case 'augment':` block are now
built from `getDirName('augment')` (dirName-derived, byte-identical) instead
of a hardcoded `.augment` literal, and the
`applyRuntimeContentRewritesForCommandsInPlace` command-body conversion
dispatch now reads `runtime.hostBehaviors.commandBodyConverter`
(`"convertClaudeToAugmentMarkdown"`) instead of a hardcoded
`runtime === 'augment'` branch. Two dead-code sites were also removed from
`bin/install.js`: the orphaned `claudeToAugmentTools` map (superseded by the
single-sourced converters per ADR-1508 / #1675) and the unreachable
`else if (isAugment) { content = convertClaudeAgentToAugmentAgent(content); }`
inline agent-conversion branch (augment has been on the descriptor-agents path
since `_DESCRIPTOR_AGENTS_RUNTIMES` was introduced, making that `if`/`else if`
arm dead). **UPGRADE 3 — MCP companion config**
(`mergeGsdMcpServerIntoSettings`) registers the `gsd` MCP server directly
inside the same `settings.json` `mcpServers` block GSD's own hook
registration already writes (Augment hosts MCP in `settings.json`, unlike
Antigravity's standalone `mcp_config.json`) — non-destructively preserving
any other user-configured `mcpServers` entries; uninstall removes only the
GSD-owned `gsd` entry. `settings.json` is golden-excluded
(`HOOK_CONFIG_FILES`), so this upgrade produces no golden fixture change.
Source-grep guard + fail-closed negotiation coverage is in
`tests/declarative-reference-augment.test.cjs`; the dispatch/hook-bus/MCP
upgrade coverage is in `tests/augment-upgrades.test.cjs`.

---

## qwen

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://qwenlm.github.io/qwen-code-docs/en/developers/channel-plugins | "Your entry point exports a ChannelPlugin object... this.registerCommand('mycommand', async (envelope, args) => { ... }); ... plugins load at startup as extensions." |
| commandSurface | slash-file | https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction | "Extensions can provide custom commands by placing Markdown files in a commands/ subdirectory" |
| modelMode | passive | https://qwenlm.github.io/qwen-code-docs/en/developers/channel-plugins | "The documentation does not expose a direct API for plugins to invoke the LLM or model directly." |
| hookBus | host | https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks | "Qwen Code provides 14 distinct hook events: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop" |
| stateIO | filesystem | https://qwenlm.github.io/qwen-code-docs/en/developers/channel-plugins | "Runtime Environment: Node.js only. The architecture uses standard Node.js APIs: import, async/await, file I/O (writeFileSync), OS utilities" |
| transport | mcp | https://qwenlm.github.io/qwen-code-docs/en/developers/tools/mcp-server | "Qwen Code integrates with MCP servers through a sophisticated discovery and execution system" |
| runtime | node | https://qwenlm.github.io/qwen-code-docs/en/developers/channel-plugins | "Language: Node.js (TypeScript/JavaScript). Execution model: In-process — plugins load at startup as extensions." |
| dispatch.namedDispatch | true | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ | "Named subagents are invoked when the AI identifies tasks matching their specialization... Users can also explicitly requ" |
| dispatch.nested | false | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ | "Fork children cannot create further forks. This is enforced at runtime — if a fork attempts to spawn another fork, it re" |
| dispatch.maxDepth | 1 | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ | "Fork children cannot create further forks. This is enforced at runtime" |
| dispatch.background | true | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ | "Runs in background, parent continues immediately... Forks run parallel to the parent; the main conversation continues im" |
| dispatch.subagentToolkit | full | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ | "When omitted, the subagent inherits all available tools from the parent session." |
| dispatch.backgroundDispatch | false | https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/ (official Qwen Code documentation, 'Subagents' user guide page) and https://qwenlm.github.io/qwen-code-docs/en/design/fork-subagent/fork-subagent-design (Qwen Code fork-subagent design document, section '4. Recursive Fork Prevention') | The official user-facing Qwen Code docs state verbatim: "Fork children cannot create further forks. If a fork attempts spawning another fork, it receives an error instructing direct task execution ins |
| dispatch.isolation | undocumented | not researched / no concurrent fan-out documented for this axis | no authoritative source consulted for concurrent-executor isolation on this host — fails closed to `none` (sequential) in negotiation (#2584) |

Sources consulted:
- https://qwenlm.github.io/qwen-code-docs/en/developers/channel-plugins
- https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/
- https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks
- https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction
- https://qwenlm.github.io/qwen-code-docs/en/developers/tools/mcp-server
- /websites/qwenlm_github_io_qwen-code-docs_en (Context7)
- /qwenlm/qwen-code (Context7)

Documentation gaps:
- dispatch.nested — docs only restrict fork-type sub-agents from nesting; whether named sub-agents can themselves spawn named sub-agents is not stated.
- dispatch.maxDepth — depth=1 is documented only for fork sub-agents; depth for named sub-agent chains is undocumented.

**EoS migration status (#2092):** Migrated onto the imperative adapter. All `runtime === 'qwen'` branches in `bin/install.js`, `src/install-engine.cts`, `src/runtime-artifact-conversion.cts`, and `src/runtime-hooks-surface.cts` folded into descriptor-driven `runtime.hostBehaviors`. Two upgrades land: (1) **native subagent projection** — a new `agents` artifact-layout kind projects GSD's specialist agents into `~/.qwen/agents/gsd-*.md` as native Qwen subagents via `convertClaudeAgentToQwenAgent`, emitting Qwen's own `name:`/`description:`/`tools:` (YAML block list) frontmatter schema instead of Claude Code's; cite https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/. (2) **`SubagentStart` hook** — wired into `extendedHookEvents` alongside the existing `SubagentStop`/`Stop`/`PreCompact` events, firing the context-monitor hook symmetrically at subagent start and completion; cite https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks.

---

## codebuddy

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://www.codebuddy.ai/docs/cli/plugins-reference | "Commands are 'plain Markdown file[s]' located in commands/ by default ... a skill is a directory containing a SKILL.md ... The documentation" |
| commandSurface | slash-file | https://www.codebuddy.ai/docs/cli/plugins-reference | "Commands are 'plain Markdown file[s]' located in commands/ by default ... Skills are prefixed with this (e.g., /my-first-plugin:hello)" |
| modelMode | passive | https://www.codebuddy.ai/docs/cli/sdk | "The SDK is not for building plugins that run inside CodeBuddy. It's an external SDK for standalone applications" |
| hookBus | host | https://www.codebuddy.ai/docs/cli/hooks | "Full support for the hook event family (27+ events), covering tool lifecycle (PreToolUse / PostToolUse / PostToolUseFailure)" |
| stateIO | filesystem | https://www.codebuddy.ai/docs/cli/settings | "Storage operates in non-sandboxed mode by default ... Default: Full filesystem access governed by permission rules" |
| transport | mcp | https://www.codebuddy.ai/docs/cli/cli-reference | "MCP (Model Context Protocol) is built-in as a core feature ... codebuddy mcp command to 'Configure Model Context Protocol (MCP) servers'" |
| runtime | node | https://www.codebuddy.ai/docs/cli/sdk | "TypeScript/JavaScript: Node.js >= 18.20 ... npm install @tencent-ai/agent-sdk" |
| dispatch.namedDispatch | true | https://www.codebuddy.ai/docs/cli/sub-agents | "Sub-agents can be invoked explicitly by name: 'Request a specific sub-agent by mentioning it in your command'" |
| dispatch.nested | false | https://www.codebuddy.ai/docs/cli/sub-agents | "This prevents infinite nesting of agents (sub-agents cannot spawn other sub-agents)" |
| dispatch.maxDepth | 1 | https://www.codebuddy.ai/docs/cli/sub-agents | "The architecture enforces exactly one level of nesting — only the main CodeBuddy Code instance can invoke sub-agents." |
| dispatch.background | true | https://www.codebuddy.ai/docs/cli/sub-agents | "Launch a background agent using the run_in_background: true parameter ... Tasks return immediately with an ID" |
| dispatch.subagentToolkit | full | https://www.codebuddy.ai/docs/cli/sub-agents | "By default, sub-agents inherit all tools when the tools field is omitted ... Sub-agents can access MCP tools from config" |
| dispatch.backgroundDispatch | false | https://www.codebuddy.ai/docs/cli/sub-agents | "This prevents infinite nesting of agents (sub-agents cannot spawn other sub-agents)" — the restriction is stated as universal in the Sub-Agents documentation page. The daemon/background docs (https:/ |
| dispatch.isolation | undocumented | not researched / no concurrent fan-out documented for this axis | no authoritative source consulted for concurrent-executor isolation on this host — fails closed to `none` (sequential) in negotiation (#2584) |

Sources consulted:
- https://www.codebuddy.ai/docs/cli/plugins
- https://www.codebuddy.ai/docs/cli/plugins-reference
- https://www.codebuddy.ai/docs/cli/sub-agents
- https://www.codebuddy.ai/docs/cli/hooks
- https://www.codebuddy.ai/docs/cli/sdk
- https://www.codebuddy.ai/docs/cli/settings
- /websites/codebuddy_cn (Context7)

**EoS migration status (#2098):** Migrated onto the declarative adapter (dogfooded in `tests/declarative-reference-codebuddy.test.cjs`). The two remaining `isCodebuddy` branches in `bin/install.js` — a duplicate `commands/` slash-command output report, and a dead legacy agent-converter dispatch arm (unreachable since codebuddy is in `_DESCRIPTOR_AGENTS_RUNTIMES`) — were folded onto the already-generic `runtime.hostBehaviors.reportCommandsDir` (shared with Cursor) and removed outright; `isCodebuddy` no longer appears as a live read anywhere in `bin/install.js`, `src/runtime-artifact-conversion.cts`, `src/shell-command-projection.cts`, or `src/runtime-name-policy.cts`. Two upgrades land: (1) **extended hook events** — codebuddy's `extendedHookEvents` was previously `[]` (none wired); this PR wires all four — `SubagentStop`/`Stop`/`PreCompact`/`SubagentStart` — into `extendedHookEvents` (mirrors qwen/kimi), so an install now registers all four as hooks in `settings.json` alongside the pre-existing base session/tool events (`SessionStart`/`PreToolUse`/`PostToolUse`); cite https://www.codebuddy.ai/docs/cli/hooks. (2) **`dispatch.background`** — the descriptor already declared `true`, exceeding the `declarative-cli` profile baseline of `false`; the negotiation contract (`negotiateHostCapabilities`) now surfaces that value with no downgrade warning, documenting the legitimate deviation. Note: the CodeBuddy CLI has no background-dispatch frontmatter field on sub-agents (`agentMode`/`enabledAutoRun` are IDE-only per https://www.codebuddy.ai/docs/cli/sub-agents) — background dispatch remains a caller-side invocation parameter (`run_in_background: true`), not a field GSD's agent artifacts emit.

---

## copilot

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features | "Declarative elements include custom instructions, skills, custom agents, and plugin configurations—all defined through configuration files" |
| commandSurface | slash-file | https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features | "Skills: Markdown files with instructions for specific contexts. Users can invoke via slash commands (e.g., /Markdown-Checker check README.md)" |
| modelMode | passive | https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md | "Model selection via config: model: 'gpt-4.1', provider: { type: 'openai', ... }." |
| hookBus | host | https://docs.github.com/en/copilot/reference/hooks-reference | "Hooks allow you to extend and customize the behavior of GitHub Copilot agents by executing custom shell commands at key points during agent" |
| stateIO | filesystem | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers | "Configuration file Location: ~/.copilot/mcp-config.json. Hook config files stored in .github/hooks/*.json" |
| transport | mcp | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers | "Copilot CLI comes with the GitHub MCP server already configured. STDIO is the standard transport." |
| runtime | undocumented | no authoritative doc — searched: https://github.com/github/copilot-cli/blob/main/README.md, https://github.com/github/copilot-sdk/blob/main/nodejs/README.md | — |
| dispatch.namedDispatch | true | https://github.com/github/copilot-sdk/blob/main/docs/features/custom-agents.md | "A custom agent is a named agent configuration that includes its own prompt and tool set. A sub-agent is a custom agent i" |
| dispatch.nested | false | https://awesome-copilot.github.com/learning-hub/agents-and-subagents/ | "By default, subagents do not keep spawning additional subagents." |
| dispatch.maxDepth | 1 | https://awesome-copilot.github.com/learning-hub/agents-and-subagents/ | "Depth counts how many agents are nested within one another. When the depth limit is reached, the innermost agent cannot" |
| dispatch.background | true | https://docs.github.com/en/copilot/how-tos/copilot-cli/speed-up-task-completion | "Allow Copilot to use subagents and work autonomously to implement the plan without any further input." |
| dispatch.subagentToolkit | full | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli | "By default, custom agents have access to all tools. If you restrict an agent's access, a tools specification is added" |
| dispatch.backgroundDispatch | false | https://code.visualstudio.com/docs/copilot/agents/subagents | "By default, subagents cannot spawn further subagents. This prevents infinite recursion when agents accidentally call themselves in a loop." The setting `chat.subagents.allowInvocationsFromSubagents` |
| dispatch.isolation | undocumented | not researched / no concurrent fan-out documented for this axis | no authoritative source consulted for concurrent-executor isolation on this host — fails closed to `none` (sequential) in negotiation (#2584) |

Sources consulted:
- https://github.com/github/copilot-cli/blob/main/README.md (via Context7 /github/copilot-cli)
- https://github.com/github/copilot-sdk/blob/main/docs/features/custom-agents.md (via Context7 /github/copilot-sdk)
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- https://docs.github.com/en/copilot/reference/hooks-reference
- https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features
- https://awesome-copilot.github.com/learning-hub/agents-and-subagents/

Documentation gaps:
- runtime — docs describe the CLI binary and the SDK (Node.js/Go/Python/Rust) but do not state what runtime the CLI host itself or its plugin/extension loader executes in.
- dispatch.nested exact authoritative source is awesome-copilot.github.com (community docs) not docs.github.com.

**EoS migration status (#2099):** Migrated onto the declarative adapter (dogfooded in `tests/declarative-reference-copilot.test.cjs`). The residual `isCopilot` branches were folded onto descriptor-driven `runtime.hostBehaviors`: the `.agent.md` destination-suffix rename in `src/install-engine.cts` now reads `hostBehaviors.agentFileExtension`; `bin/install.js`'s two uninstall side-effect branches (repo-root `AGENTS.md` cleanup, `copilot-instructions.md`/hook cleanup) now gate on `resolveInstallPlan(runtime).installSurface === 'copilot-instructions'` (unique to copilot, so byte-identical); and the two `skipSharedHooksInstall` checks now read `hostBehaviors.skipSharedHooksInstall:true` (copilot's golden has only `hooks/gsd-session.json`, no shared `gsd-*.js` scripts). A dead legacy agent-converter dispatch arm in the inline agent-copy loop — unreachable since copilot is a member of `_DESCRIPTOR_AGENTS_RUNTIMES` — was removed outright; `isCopilot` no longer appears as a live read anywhere in `bin/install.js` or `src/install-engine.cts`. Two upgrades land: (1) **multi-event hook bus** — `buildCopilotHookConfig()` previously emitted only `sessionStart`; this PR wires four additional events — `preToolUse`/`postToolUse`/`userPromptSubmitted`/`sessionEnd` — each a static, deterministic advisory command (no node-runner invocation), so an install's `hooks/gsd-session.json` now registers all five events. (2) **`dispatch.background`** — the descriptor already declared `true`, exceeding the `declarative-cli` profile baseline of `false`; the negotiation contract (`negotiateHostCapabilities`) surfaces that value with no downgrade warning, documenting the legitimate deviation. Note: Copilot's `.agent.md` frontmatter has no background-dispatch field (fields are `description`/`infer`/`mcp-servers`/`model`/`name`/`tools`) — background dispatch remains a negotiated-contract-only axis, not a field GSD's agent artifacts emit. MCP companion tooling is out of scope for this migration (AC4 names only the two upgrades above).

---

## kilo

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://kilo.ai/docs/automate/extending/plugins | "Plugins extend Kilo by hooking into events and adding functionality. They can: add custom tools the model can call (like read, write, bash)" |
| commandSurface | slash-file | https://kilo.ai/docs/customize/workflows | "Workflows, also known as slash commands, allow users to automate repetitive tasks by defining step-by-step instructions" |
| modelMode | active | https://kilo.ai/docs/automate/extending/plugins | "provider — dynamically supply model catalogs. auth — register OAuth or API-key flows for model providers. chat.params — Mutate temperature" |
| hookBus | host | https://kilo.ai/docs/automate/extending/plugins | "event — fires for every internal bus event. Session: session.created, session.updated, session.idle, session.error, session.deleted" |
| stateIO | filesystem | https://kilo.ai/docs/contributing/architecture | "Local execution and hosted execution are separate boundaries. Local runtime instances are Directory-keyed runtime context" |
| transport | mcp | https://kilo.ai/docs/automate/mcp/what-is-mcp | "Kilo Code implements the Model Context Protocol to connect to both local and remote MCP servers" |
| runtime | bun | https://kilo.ai/docs/automate/extending/plugins | "npm plugins are installed automatically at startup using Bun. Plugin context includes $ (Bun shell). Plugins are TypeScript or JavaScript mo" |
| dispatch.namedDispatch | true | https://kilo.ai/docs/customize/custom-subagents | "Configured subagents can be invoked automatically by primary agents (like the Orchestrator) using the Task tool" |
| dispatch.nested | true | https://github.com/Kilo-Org/kilocode/issues/7055 | "A subagent can still call the task tool if its merged permissions contain an explicit task rule, which enables nested su" |
| dispatch.maxDepth | -1 | https://github.com/Kilo-Org/kilocode/issues/8637 | "there is no maximum nesting depth and the system relies entirely on permission gating" |
| dispatch.background | true | https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode | "Agents are also capable of launching multiple subagent sessions concurrently to facilitate parallel processing." |
| dispatch.subagentToolkit | undocumented | no authoritative doc — searched: https://kilo.ai/docs/customize/custom-subagents | — |
| dispatch.backgroundDispatch | false | https://kilo.ai/docs/automate/tools/new-task | "Importantly, subagents cannot spawn further subagents; only primary agents can use the `new_task` tool." |
| dispatch.isolation | undocumented | not researched / no concurrent fan-out documented for this axis | no authoritative source consulted for concurrent-executor isolation on this host — fails closed to `none` (sequential) in negotiation (#2584) |

Sources consulted:
- https://kilo.ai/docs/automate/extending/plugins
- https://kilo.ai/docs/customize/custom-subagents
- https://kilo.ai/docs/customize/workflows
- https://kilo.ai/docs/automate/mcp/what-is-mcp
- https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode
- https://kilo.ai/docs/contributing/architecture
- https://github.com/Kilo-Org/kilocode/issues/7055
- https://github.com/Kilo-Org/kilocode/issues/8637
- /websites/kilo_ai (Context7)

Documentation gaps:
- dispatch.subagentToolkit — docs describe per-subagent configurable permissions (allow/ask/deny) but do not document a single default toolkit level (full vs read-only) for subagents that lack explicit permission overrides.

**EoS migration status (#2093):** Migrated onto the imperative adapter. All `runtime === 'kilo'` / `isKilo` logic branches in `bin/install.js`, `src/install-engine.cts`, `src/runtime-artifact-conversion.cts`, and `src/runtime-artifact-layout.cts` folded into descriptor-driven `runtime.hostBehaviors` (`finishPermissionWriter`, `skipSharedHooksInstall`, and the skills converter registry are now resolved off the descriptor, not a hardcoded Kilo check). Four upgrades land: (1) **native hook-bus plugin** — `.kilo/plugins/gsd-core.js` (byte-identical to `.opencode/plugins/gsd-core.js`, cite: Kilo is an OpenCode fork sharing the same plugin/extension event bus) bridges GSD's hook scripts onto Kilo's plugin event bus; `extensionEvents: "kilo"` reuses `OPENCODE_EXTENSION_EVENTS` verbatim. (2) **active-model routing** — `convertClaudeToKiloFrontmatter` now emits a `model:` field from the resolved `model_overrides`/`model_profile_overrides.kilo.<tier>` value instead of always stripping it (mirrors the OpenCode upgrade; #2256). (3) **MCP companion documented** — `docs/how-to/connect-gsd-mcp-server.md` covers Kilo's `mcp`-keyed config (not `mcpServers`) and its `{type:"local", command, timeout}` entry shape. (4) **named subagent dispatch** — GSD's specialist agents install as `<configDir>/agents/gsd-*.md` with `mode: subagent` frontmatter (the slug Kilo's Task tool dispatches by) and a `permission:` block. `dispatch.subagentToolkit` stays `undocumented` — no authoritative Kilo doc states a default subagent toolkit level — so `degradationFor('dispatch', …)` returns `'degraded'`, not `'full'`, by design (fail-closed negotiation, not a regression).

---

## windsurf

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://docs.devin.ai/desktop/cascade/cascade | "Cascade operates through configuration files rather than code plugins: .codeiumignore for file filtering, Memories and Rules for customizing" |
| commandSurface | slash-file | https://docs.devin.ai/desktop/cascade/workflows | "Workflows are authored as markdown files (.md extension) … triggered through slash commands using the format /[workflow-name]." |
| modelMode | passive | https://docs.devin.ai/desktop/models.md | "Models are selectable via configuration/UI only (SWE-1.5, SWE-1.6, Adaptive, Arena tiers, Claude, GPT)." |
| hookBus | host | https://docs.devin.ai/desktop/cascade/hooks.md | "Cascade supports twelve hook events covering critical workflow points … Pre-hooks (can block actions): pre_read_code, pre_write_code, pre_run_command, …" (quote elided beyond the pre-hook enumeration — see #2100 CASCADE FACTS reference) |
| stateIO | filesystem | https://docs.devin.ai/desktop/cascade/cascade | "Cascade can create and modify codebases directly … File access can be restricted through .codeiumignore files" |
| transport | mcp | https://docs.devin.ai/desktop/cascade/mcp | "Cascade now natively integrates with MCP, allowing you to bring your own selection of MCP servers for Cascade to use." |
| runtime | undocumented | no authoritative doc — searched: https://docs.devin.ai/windsurf/plugins/getting-started.md, /llmstxt/windsurf_llms-full_txt (Context7) | — |
| dispatch.namedDispatch | undocumented | no authoritative doc — searched: https://docs.devin.ai/cli/subagents.md, https://docs.devin.ai/desktop/agent-command-center.md | — |
| dispatch.nested | undocumented | no authoritative doc — searched: https://docs.devin.ai/cli/subagents.md | — |
| dispatch.maxDepth | undocumented | no authoritative doc — searched: https://docs.devin.ai/cli/subagents.md | — |
| dispatch.background | undocumented | no authoritative doc — searched: https://docs.devin.ai/desktop/acp.md, https://docs.devin.ai/cli/subagents.md | — |
| dispatch.subagentToolkit | undocumented | no authoritative doc — searched: https://docs.devin.ai/cli/subagents.md | — |
| dispatch.backgroundDispatch | undocumented | no authoritative doc — https://docs.devin.ai/desktop/cascade/cascade and https://docs.devin.ai/desktop/devin-local (official Windsurf/Devin docs, via docs.windsurf.com redirects) | The Windsurf/Cascade docs describe a background planning agent only in these terms: "In the background, a specialized planning agent continuously refines the long-term plan while your selected model f |
| dispatch.isolation | none | shipped descriptor (`dispatch.backgroundDispatch: undocumented`) | no documented background/concurrent-dispatch primitive — isolation is moot; same-wave plans run inline (#2584) |

Sources consulted:
- https://docs.devin.ai/desktop/cascade/workflows
- https://docs.devin.ai/desktop/cascade/mcp
- https://docs.devin.ai/desktop/cascade/hooks.md
- https://docs.devin.ai/desktop/cascade/cascade
- https://docs.devin.ai/desktop/models.md
- https://docs.devin.ai/windsurf/plugins/getting-started.md
- https://docs.devin.ai/cli/subagents.md
- /llmstxt/windsurf_llms-full_txt (Context7)

Documentation gaps:
- dispatch.namedDispatch — Cascade docs do not document a user-facing named sub-agent dispatch system.
- dispatch.nested — no documentation for nested sub-agent support in Windsurf Cascade.
- dispatch.maxDepth — no documented depth limit for Cascade sub-agents.
- dispatch.background — Cascade has an internal background planning agent but no documented user-facing background sub-agent dispatch.
- dispatch.subagentToolkit — no documentation for toolkit restrictions on Cascade sub-agents.
- runtime — Windsurf IDE is Electron-based but no programmatic plugin runtime is documented to developers.

**EoS migration status (#2100 Stage 2 — HOOK-BRIDGE):** `hooksSurface` moved from `"none"` to `"windsurf-hooks-json"`. GSD now wires two of Cascade's documented pre-hooks with BLOCKING semantics via `.windsurf/hooks.json` (local) / `~/.codeium/windsurf/hooks.json` (global): `pre_write_code` (write-path guard — blocks a write resolving to a different git root than cwd, or into a `.git/` internals directory) and `pre_run_command` (a conservative destructive-command deny-list — whole-disk/home `rm -rf`, force-push to a protected branch). Cascade blocks via **exit code 2** (+ a stderr reason string) — a materially different protocol from Cursor's stdout-JSON `{block, reason}` hooks.json form, even though the surrounding install/reconcile infra (`writeWindsurfHooksJson`/`removeWindsurfHooksJson` in `src/runtime-hooks-surface.cts`) mirrors `writeCursorHooksJson`/`removeCursorHooksJson`'s shape. Cascade has **no context-injection channel** (no `additional_context`-style advisory response channel), so the 4 advisory hook events GSD registers on Cursor (`sessionStart`, `postToolUse`, `stop`, `subagentStart`/`subagentStop`) have no Windsurf/Cascade counterpart and are deliberately **not ported** — only the 2 events with a genuine blocking analog are wired. `installSurface` stays `profile-marker-only` (unchanged); the hook bus is wired from inside that branch, gated on `hooksSurface === 'windsurf-hooks-json'` rather than a hardcoded runtime check.

---

## trae

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://traeide.com/docs/how-to-manage-extensions-in-trae-ide | "Trae IDE is a VSCode fork; 'If an extension isn't available in Trae's store, you can install it from VS Code's marketplace' — inherits VSCode in-process extension model" |
| commandSurface | slash-file | https://docs.trae.ai/ide/skills | "Skills stored as SKILL.md files in '.trae/skills/{skill_name}/' directory; 'Trae allows you to manually trigger skills if needed'" |
| modelMode | passive | https://docs.trae.ai/ide/models | "Model selection via UI: 'click on the current model name to open the model list'; no programmatic model/LLM request API documented for plugins" |
| hookBus | engine | https://news.ycombinator.com/item?id=44703164 | "Trae is 'ByteDance's VSCode fork' built on Electron/Monaco; inherits VSCode extension host lifecycle (activate/deactivate hooks, event subsc" |
| stateIO | filesystem | https://traeide.com/news/6 | "Rules at '.trae/project_rules.md', skills at '.trae/skills/', MCP config at '.trae/mcp.json'; 'codebase files always remain on your local de" |
| transport | mcp | https://docs.trae.ai/ide/model-context-protocol | "Page title from official docs: 'In TRAE IDE, MCP servers support three transport types' — MCP is built-in" |
| runtime | node | https://news.ycombinator.com/item?id=44703164 | "Trae is a VSCode fork built on Electron; 'Electron is designed to create desktop applications… a backend using the Node.js runtime'" |
| dispatch.namedDispatch | true | https://docs.trae.ai/ide/agent | "Agents in Trae 'can be called individually, or automatically called by SOLO Agent at the corresponding stage'" |
| dispatch.nested | undocumented | no authoritative doc — searched: https://docs.trae.ai/ide/solo-mode, https://docs.trae.ai/ide/agent | — |
| dispatch.maxDepth | undocumented | no authoritative doc — searched: https://docs.trae.ai/ide/solo-mode | — |
| dispatch.background | true | https://news.aibase.com/news/22829 | "SOLO 'supports multi-tasking, allowing you to work on multiple development tasks simultaneously'; 'run multiple agents i" |
| dispatch.subagentToolkit | undocumented | no authoritative doc — searched: https://docs.trae.ai/ide/agent | — |
| dispatch.backgroundDispatch | undocumented | no authoritative doc — https://docs.trae.ai/ide/agent; https://github.com/bytedance/trae-agent/blob/main/docs/roadmap.md | Trae's official documentation (docs.trae.ai) and the trae-agent GitHub roadmap do not document background/async agent dispatch or whether a background-spawned agent can itself spawn further sub-agents |
| dispatch.isolation | undocumented | not researched / no concurrent fan-out documented for this axis | no authoritative source consulted for concurrent-executor isolation on this host — fails closed to `none` (sequential) in negotiation (#2584) |

Sources consulted:
- https://docs.trae.ai/ide/model-context-protocol
- https://docs.trae.ai/ide/agent
- https://docs.trae.ai/ide/skills
- https://docs.trae.ai/ide/solo-mode
- https://docs.trae.ai/ide/solo-coder
- https://traeide.com/news/6
- https://traeide.com/docs/how-to-manage-extensions-in-trae-ide
- https://news.ycombinator.com/item?id=44703164
- https://news.aibase.com/news/22829

Documentation gaps:
- dispatch.nested — docs describe two-tier orchestration (SOLO → named agents) but do not state whether a spawned sub-agent can itself spawn further sub-agents.
- dispatch.maxDepth — no integer depth limit documented beyond one orchestrator level.
- dispatch.subagentToolkit — docs say agents can be configured with 'callable MCP services and other capabilities' but do not state whether sub-agents receive a full vs. restricted tool set.

**EoS migration status (#2094):** Migrated onto the imperative adapter — partially. Two `runtime === 'trae'` string-equality branches folded into descriptor-driven `runtime.hostBehaviors`: `skipSharedHooksInstall:true` gates the shared-hooks install (Trae has no hook surface: `hooksSurface: "none"`), and the `case 'trae'` global-config-dir path-rewrite's self-alias regex is now built off the descriptor's `dirName` rather than a hardcoded `~/.trae/` literal (byte-identical output). Skills dispatch was already descriptor-driven before this migration (`artifactLayout.skills.converter: "convertClaudeCommandToTraeSkill"`, resolved by converter name, not a runtime check). **Still runtime-keyed** (not folded by #2094, matching the same posture as cursor/windsurf/cline, pending a future cross-runtime content-dispatch consolidation): `RUNTIME_CONTENT_DISPATCH.trae` in `bin/install.js` — its `md`/`js` bodies are regex-callback rewrites that cannot be reduced to a byte-identical descriptor map; and the `case 'trae':` switch arm itself in `src/runtime-artifact-conversion.cts` — the arm's *structure* (not just its self-alias regex) is boilerplate shared verbatim across 7 runtimes (`codex`, `cline`, `cursor`, `windsurf`, `augment`, `trae`, `codebuddy`) and remains a runtime-keyed `switch`. `trae` also remains in `RUNTIME_FLAG_IDS` (and `isTrae` remains in `bin/install.js`, gating only the agents-converter dispatch) pending the cross-runtime agents-converter dispatch migration — agents conversion is out of scope for #2094. One upgrade lands: **SOLO stage/trigger metadata** — every emitted `SKILL.md` now carries a `stage: workflow` frontmatter line (`runtime.hostBehaviors.soloStageMetadata`), so Trae's SOLO Agent can recognize GSD skills as workflow-stage skills for auto-invocation instead of requiring manual triggering; cite https://docs.trae.ai/ide/agent ("Agents in Trae can be called individually, or automatically called by SOLO Agent at the corresponding stage"). The field is a single fixed, best-effort/inferred GSD-side value — Trae's thin SPA docs don't publish a formal stage-metadata schema. The four `undocumented` dispatch sub-axes (`nested`, `maxDepth`, `subagentToolkit`, `backgroundDispatch`) keep dispatch flattened (`shouldFlattenDispatch` fails closed to inline) — fail-closed negotiation, not a regression.

---

## kimi

**EoS migration status (#2095):** Two upgrades landed. **Upgrade 1 — native hook bus:** `hooksSurface` moved from `"none"` to `"kimi-hooks-toml"` (`extendedHookEvents: ["SubagentStop", "Stop", "PreCompact", "SubagentStart"]`, `hookEvents: "claude"` — Kimi's 13 lifecycle events include exact-name equivalents for every Claude-dialect event GSD wires). GSD's hook scripts (session-state, phase-boundary, graphify, context monitor, the prompt/read/workflow/worktree guards, commit validation) are now registered as `[[hooks]]` entries in Kimi's own `config.toml` (default `~/.kimi/config.toml`, overridable via Kimi's own `KIMI_SHARE_DIR` env var — a directory deliberately separate from the `~/.config/agents` Agent-Skills root GSD installs into, since Kimi's docs confirm the skills search path is independent of `KIMI_SHARE_DIR`). GSD-owned entries are wrapped in `# GSD Hooks BEGIN`/`END` marker comments (`writeKimiHooksToml` / `stripKimiHooksTomlBlock` in `src/runtime-hooks-surface.cts`) so a reinstall replaces only GSD's own block, and `installSurface` deliberately stays `"profile-marker-only"` — the config.toml write is independent of the artifact-install surface. `hooks/` and `hooks/lib/` now install for kimi (the three `&& !isKimi` install-guard exclusions were removed) — but SELF-CONTAINED under kimi's own native hook root (`~/.kimi/`, alongside `config.toml`), never under the `~/.config/agents` Agent-Skills root: kimi declares `hostBehaviors.skipSharedHooksInstall:true` like Cline/Kilo/Cursor/Trae, so the shared install path never writes hooks/package.json there, and a dedicated call installs the same bundle into `resolveKimiHooksTomlDir()` instead, with `buildHookCommand` pointed at that root so the generated `[[hooks]]` command paths resolve. **Upgrade 2 — background dispatch:** `hostIntegration.dispatch.backgroundDispatch` flipped `false` → `true` (Kimi's `Agent` tool takes a call-time `run_in_background` param — same evidence as `dispatch.background` below), which flips `shouldFlattenDispatch` to `false` for kimi (may background, joining codex/cursor/opencode) — a negotiation-only axis with no install-output effect, confirmed via golden parity. Exercising the actual `run_in_background` call end-to-end is Kimi's own runtime behavior and is out of the installer's test scope; the installer's deliverable stops at the `kimi_cli.tools.agent:Agent` tool grant on the root agent YAML (`buildKimiAgentArtifacts`, only emitted when a subagent is present) plus the negotiated `backgroundDispatch` axis above — both covered by `tests/kimi-upgrades.test.cjs`. **MCP transport deferred:** kimi's `transport: mcp` axis (declared below) is descriptor-only, like every other runtime's — no runtime has installer-driven MCP registration (GSD's installer never invokes `kimi mcp add`); users register the GSD MCP companion server with Kimi CLI manually.

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://context7.com/moonshotai/kimi-cli/llms.txt | "from kimi_cli.app import KimiCLI, enable_logging ... instance = await KimiCLI.create(session, agent_file=myagent) ... class Ls(CallableTool2)" |
| commandSurface | slash-file | https://github.com/moonshotai/kimi-cli/blob/main/docs/en/customization/skills.md | "/skill:code-style ... /flow:code-review — Skills are SKILL.md markdown files with YAML frontmatter that become /skill:<name> and /flow:<name>" |
| modelMode | passive | https://github.com/moonshotai/kimi-cli/blob/main/docs/en/configuration/providers.md | "Use the `/model` command to switch between available models and thinking modes ... `--model` option overrides the default model" |
| hookBus | host | https://moonshotai.github.io/kimi-cli/en/customization/hooks.html | "Core: Add hooks system (Beta) — configure `[[hooks]]` in `config.toml` to run custom shell commands at 13 lifecycle events including `PreToo" |
| stateIO | filesystem | https://github.com/MoonshotAI/kimi-cli | "Kimi Code CLI is an AI agent that runs in the terminal ... capable of reading and editing code, executing shell commands, searching files" |
| transport | mcp | https://github.com/moonshotai/kimi-cli/blob/main/docs/en/reference/kimi-mcp.md | "kimi mcp add ... --transport stdio|http ... Manage MCP Servers: Use the kimi mcp sub-command group to add, list, remove, or authorize MCP se" |
| runtime | python | https://context7.com/moonshotai/kimi-cli/llms.txt | "from kimi_cli.app import KimiCLI ... from kosong.tooling import CallableTool2 — CLI core is Python" |
| dispatch.namedDispatch | true | https://moonshotai.github.io/kimi-cli/en/customization/agents.html | "subagents:\n  coder:\n    path: ./coder-sub.yaml\n    description: \"Handle coding tasks\"\n  reviewer:\n    path: ./reviewer-sub.yaml" |
| dispatch.nested | false | https://moonshotai.github.io/kimi-cli/en/customization/agents.html | "All subagent types are prohibited from nesting the `Agent` tool (subagents cannot create their own subagents). Only root" |
| dispatch.maxDepth | 1 | https://moonshotai.github.io/kimi-cli/en/customization/agents.html | "All subagent types are prohibited from nesting the `Agent` tool (subagents cannot create their own subagents). Only root" |
| dispatch.background | true | https://moonshotai.github.io/kimi-cli/en/customization/agents.html | "Subagents support foreground and background modes. The `run_in_background` parameter allows tasks to execute asynchronou" |
| dispatch.subagentToolkit | undocumented | no authoritative doc — searched: https://moonshotai.github.io/kimi-cli/en/customization/agents.html | — |
| dispatch.backgroundDispatch | true (#2095 Upgrade 2; was `false`) | https://moonshotai.github.io/kimi-cli/en/customization/agents.html | "Subagents support foreground and background modes. The `run_in_background` parameter allows tasks to execute asynchronously" (same evidence as dispatch.background above — the root agent's `Agent` tool call itself takes the `run_in_background` param) |
| dispatch.isolation | orchestrator-worktree | https://github.com/moonshotai/kimi-cli/blob/main/docs/en/faq.md ; /docs/en/customization/agents.md | "`--work-dir` flag sets an explicit working directory"; concurrent "explore" subagents documented — GSD creates + manages the worktree and points the executor at it via `--work-dir` (#2584) |

Sources consulted:
- https://moonshotai.github.io/kimi-cli/en/customization/hooks.html
- https://moonshotai.github.io/kimi-cli/en/customization/agents.html
- https://github.com/MoonshotAI/kimi-cli
- https://github.com/moonshotai/kimi-cli/blob/main/docs/en/customization/skills.md
- https://github.com/moonshotai/kimi-cli/blob/main/docs/en/customization/agents.md
- https://github.com/moonshotai/kimi-cli/blob/main/docs/en/reference/kimi-mcp.md
- https://context7.com/moonshotai/kimi-cli/llms.txt
- /moonshotai/kimi-cli (Context7)

Documentation gaps:
- dispatch.subagentToolkit — docs show three built-in subagent types each with different tool subsets (coder=full, explore=read-only, plan=no shell/write); no single 'full' or 'read-only' value covers all types; maintainer should clarify the intended classification.
- runtime — CLI core is Python; a Rust Wire implementation also exists; docs do not state a canonical plugin extension runtime.

---

## zcode

> ZCode (Z.ai) is a desktop Agentic Development Environment for the GLM-5.2 model, distributed as an Electron app. It exposes a Claude-Code-shaped extensibility surface (per-user `~/.zcode/skills/<name>/SKILL.md`, slash commands, named subagents, native MCP, and a plugin system). All values below are sourced verbatim from the official ZCode docs.

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | declarative | https://zcode.z.ai/en/docs/plugin | "A single plugin can bundle several capabilities. ZCode detects which components a plugin includes from its directory layout" — plugins/skills/commands/agents are config/markdown files; no in-process programmatic extension API is documented. |
| commandSurface | slash-file | https://zcode.z.ai/en/docs/commands | "Custom commands are stored as `.md` files under `~/.zcode/commands` ... invoke the command with `/command-name`" |
| modelMode | passive | https://zcode.z.ai/en/docs/configuration | Models are connected by provider config (Z.ai/BigModel/OpenAI-compat/Anthropic-compat base URLs + API keys in Model Settings); no programmatic model request API is documented. |
| hookBus | host | https://zcode.z.ai/en/docs/plugin | A plugin's bundled components include a "**Hook** — Automation hooks triggered on specific events" — the host fires the events a plugin subscribes to. |
| stateIO | filesystem | https://zcode.z.ai/en/docs/skill | "User-level skills for ZCode Agent: `~/.zcode/skills/<skill-name>/SKILL.md`" — full local filesystem (desktop app). |
| transport | mcp | https://zcode.z.ai/en/docs/mcp-services | "MCP (Model Context Protocol) connects external capabilities ... type as `stdio` (SSE and HTTP remote servers are also supported)" — native MCP. |
| runtime | electron | https://zcode.z.ai/en/docs/install (download path `cdn-zcode.z.ai/zcode/electron/releases/3.2.5/ZCode-3.2.5-mac-arm64.dmg`) | ZCode is shipped as an Electron desktop application; the release artifact lives under the `electron/releases` path. |
| dispatch.namedDispatch | true | https://zcode.z.ai/en/docs/subagents | "you can let the Agent pick the subagent automatically, or reference it with `@` in the chat box" — subagents are invoked by name via the Agent tool. |
| dispatch.nested | undocumented | searched: https://zcode.z.ai/en/docs/subagents | The docs do not state whether a subagent can itself spawn further subagents. |
| dispatch.maxDepth | undocumented | searched: https://zcode.z.ai/en/docs/subagents | No maximum nesting depth is documented. |
| dispatch.background | false | https://zcode.z.ai/en/docs/subagents | "**Foreground execution.** Subagents run in the foreground ... Background execution is not enabled yet." |
| dispatch.subagentToolkit | full | https://zcode.z.ai/en/docs/subagents | "**general-purpose** is the default built-in subagent ... It has access to all tools"; custom subagents default to "All permissions by default" (inherits every tool). |
| dispatch.backgroundDispatch | false | https://zcode.z.ai/en/docs/subagents | "Background execution is not enabled yet" — background dispatch is therefore impossible. |
| dispatch.isolation | none | https://zcode.z.ai/en/docs/subagents (shipped descriptor: `dispatch.backgroundDispatch: false`) | "Background execution is not enabled yet" — no concurrent fan-out primitive, so same-wave plans run inline/sequentially (#2584) |

Sources consulted:
- https://zcode.z.ai/en/docs/skill
- https://zcode.z.ai/en/docs/commands
- https://zcode.z.ai/en/docs/subagents
- https://zcode.z.ai/en/docs/mcp-services
- https://zcode.z.ai/en/docs/plugin
- https://zcode.z.ai/en/docs/configuration
- https://zcode.z.ai/en/docs/install

Documentation gaps:
- dispatch.nested / dispatch.maxDepth — ZCode's subagent docs do not state whether subagents can spawn further subagents or any depth bound.
- configHome — skills/commands/agents homes are documented (`~/.zcode/skills`, `~/.zcode/commands`, `~/.zcode/agents`); the exact settings filename under `~/.zcode` (where MCP server config is stored) is not fully documented at time of writing.
- Maintenance note — ZCode is a young, fast-moving app (observed at v3.2.x); these axes may need revision as its on-disk config layout stabilizes. Because ZCode also natively imports skills/MCP from `~/.claude`, installing GSD to BOTH `claude` and `zcode` can surface duplicated skills inside ZCode; this overlap is expected and documented.

EoS migration status (#2101, ADR-1239): ZCode's install is fully dogfooded through the declarative adapter — its shared-hooks exclusion (previously a hardcoded `!isZcode` branch in `bin/install.js`) is now folded onto `hostBehaviors.skipSharedHooksInstall`, byte-parity with the prior install (ZCode's golden install tree has zero hook files). The two capability upgrades anticipated for ZCode both remain **blocked** on undocumented on-disk formats — `hookBus` and `transport` above stay documented-but-unimplemented pending ZCode publishing those formats, and implementing a guessed format risks a false-green descriptor, so neither upgrade is wired:
- **Hook automation** (the plugin `Hook` component, `hookBus: host` above) — https://zcode.z.ai/en/docs/plugin documents the capability only at a high level ("Automation hooks triggered on specific events"; components are "detected from directory layout, shown as badges"). No config file format, on-disk location, event-name vocabulary, or payload schema is published, so GSD cannot faithfully wire hook events into a plugin bundle. BLOCKED (undocumented on-disk hook-config format).
- **MCP registration** (`transport: mcp` above) — https://zcode.z.ai/en/docs/mcp-services confirms servers are "stored in the .zcode configuration file of the chosen scope" and accepts both a bare `{"server-name":{...}}` map and an `{"mcpServers":{...}}` wrapper shape, but does not document the exact settings filename/path or full schema (the docs describe the UI flow, not the on-disk contract) — this is the same gap already noted under `configHome` above. BLOCKED (undocumented settings-filename/schema gap).

---

## pi

> pi (pi.dev) is a bun-runtime Programmatic-CLI: it exposes an in-process TypeScript `ExtensionAPI` (`registerCommand`/`registerTool`/`registerProvider`/`pi.on`) rather than a settings-file or slash-markdown surface. GSD ships a single native-extension file (`pi/gsd.cjs`) installed to `~/.pi/agent/extensions/gsd.js` (global) or `.pi/extensions/gsd.js` (local) — the programmatic-CLI peer of the OpenCode/Kilo native-plugin binding. **Sourcing note:** the citations below are the pi.dev documentation pages named in ADR-1239 Stage 1 (#2102) as the source for each axis; this environment did not have live doc-fetch access at authoring time, so the Evidence column below is a paraphrase of pi's documented extension model rather than a verbatim excerpt — a maintainer with Context7/web access should verify the exact wording before treating this section as fully cited (flagged in the #2102 PR). **Partially discharged (#2470, 2026-07-20):** pi's extension-loader contract specifically has now been read at source — `packages/coding-agent/src/core/extensions/loader.ts` in `earendil-works/pi` — confirming `discoverExtensionsInDir()` keeps only names passing `isExtensionFile()` (`.ts`/`.js`, everything else skipped silently), that accepted files load via `jiti` (CommonJS and ESM alike), and that explicit `settings.json` paths bypass the filter. The remaining axes below are still paraphrase.

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://pi.dev/docs/latest/extensions | pi extensions are loaded in-process (via jiti) and call an `ExtensionAPI` object directly (`registerCommand`/`registerTool`/`registerProvider`/`pi.on`) — an in-process programmatic API, not a config-file-only integration. |
| commandSurface | slash-programmatic | https://pi.dev/docs/latest/extensions | Commands are registered by calling `registerCommand(name, definition)` from extension code, not by dropping a markdown/TOML file — the command surface is code, not a file format. |
| modelMode | active | https://pi.dev/docs/latest/extensions | The `ExtensionAPI` exposes `registerProvider`, letting an extension supply/select model providers programmatically rather than only reading a static config value. |
| hookBus | host | https://pi.dev/docs/latest/extensions | `pi.on(event, handler)` subscribes an extension to host-fired lifecycle events (e.g. `tool_call`) — the pi host owns and fires the event bus; extensions only subscribe. |
| stateIO | session-log-append | https://pi.dev/docs/latest/session-format | pi persists conversation/tool-call state as an append-only session log/transcript format rather than exposing unrestricted local filesystem access to extensions. |
| transport | native-extension | https://pi.dev/docs/latest/extensions | Integration is a single loaded extension file (`~/.pi/agent/extensions/<file>.cjs`), not an MCP server process — the peer mechanism to OpenCode's native `plugins/*.js` adapter. |
| runtime | bun | https://pi.dev | pi is distributed and executed as a bun-runtime CLI (its extensions are loaded via jiti under bun, not Node.js or Python). |
| dispatch.namedDispatch | undocumented | no authoritative doc — searched: https://pi.dev/docs/latest/extensions | The `ExtensionAPI` documents `registerCommand`/`registerTool`/`registerProvider`/`pi.on`; it does not document a named-subagent-invocation primitive. |
| dispatch.nested | undocumented | no authoritative doc — searched: https://pi.dev/docs/latest/extensions | No documented subagent-of-subagent nesting capability. |
| dispatch.maxDepth | 0 | no authoritative doc — searched: https://pi.dev/docs/latest/extensions | No named-dispatch primitive is documented at all (see `dispatch.namedDispatch`), so there is no nesting depth to bound; `0` records "no dispatch levels beyond the root extension," not a measured limit. |
| dispatch.background | false | no authoritative doc — searched: https://pi.dev/docs/latest/extensions | No documented background/async subagent-execution primitive. |
| dispatch.subagentToolkit | undocumented | no authoritative doc — searched: https://pi.dev/docs/latest/extensions | pi has no named-dispatch primitive (see `dispatch.namedDispatch`), so there is no subagent tool-surface to classify as `full`/`read-only`. |
| dispatch.backgroundDispatch | false | no authoritative doc — searched: https://pi.dev/docs/latest/extensions | Same gap as `dispatch.background` — no background-dispatch primitive is documented, so a background-dispatched agent spawning further named sub-agents is not possible. |
| dispatch.isolation | none | shipped descriptor (`dispatch.background: false`, `dispatch.backgroundDispatch: false`) | pi has no named-dispatch/background-dispatch primitive documented — cannot fan out concurrently, so isolation is moot (#2584) |

Sources consulted:
- https://pi.dev
- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/session-format

Documentation gaps:
- dispatch.namedDispatch / dispatch.nested / dispatch.subagentToolkit — pi's `ExtensionAPI` (`registerCommand`/`registerTool`/`registerProvider`/`pi.on`) does not document a named-subagent-dispatch primitive at all, unlike Claude Code/Codex/OpenCode-style "Agent tool" surfaces; all three axes stay `undocumented` and negotiation fails closed (no named dispatch, dispatch flattened).
- dispatch.maxDepth / dispatch.background / dispatch.backgroundDispatch — recorded as `0`/`false`/`false` (not `undocumented`) because the absence of any dispatch primitive is itself the documented ceiling, matching `shouldFlattenDispatch`'s fail-closed default.
- This section's Evidence-column wording was authored without live Context7/web-fetch access (see the sourcing note above the table) — verify against the cited pi.dev pages before relying on it for a future capability upgrade.

EoS migration status (#2102 Stage 1, ADR-1239): pi lands as a NET-NEW installable runtime — pure additive descriptor + installer wiring, no prior `runtime === 'pi'` branches existed to fold. `artifactLayout` is declared empty (`global: []`, `local: []`) — pi has no skills/commands/agents layout, and installs as **PLUGIN-ONLY**: `hostBehaviors.pluginOnlyInstall: true` explicitly skips `bin/install.js`'s generic flat-commands-and-agents fallback (the legacy path Claude Code's LOCAL layout also uses), which would otherwise write inert `commands/gsd-<cmd>.md` + `agents/gsd-<name>.md` reference files no part of pi ever reads. pi's `/gsd` command and `gsd_invoke` tool are registered **programmatically** by the native extension (`pi/gsd.cjs` → `extensions/gsd.js`, mirroring OpenCode/Kilo's `nativePlugin` shape) — pi has no host-read markdown surface at all (unlike Claude/OpenCode/Kilo, which scan a `commands/`/`command/` directory), so a declarative artifact surface would be dead weight, not merely unused. `dispatch.subagentToolkit: "undocumented"` and `dispatch.backgroundDispatch: false` are both required by the capability validator's dispatch schema and reflect that pi has no documented named-dispatch primitive at all. (Stage 1 originally also set `hostBehaviors.skipSharedHooksInstall:true`, reasoning the staged `hooks/*.js` bundle would be dead weight for pi the way it genuinely is for Kilo/ZCode — **corrected in Stage 2 below**: pi's native extension DOES spawn them, so they are live, not dead, and the flag was removed.)

EoS migration status (#2102 Stage 2, ADR-1239): Stage 1's "in-process `gsd-core` command-routing hub" framing was aspirational and is corrected here — no fully-populated hub factory exists anywhere in gsd-core (every `createHub()` caller in the tree builds a single-family hub for its own narrow purpose), so `/gsd` and `gsd_invoke` instead dispatch via **SUBPROCESS REUSE**: `dispatchGsdCommand` (`src/shell-command-projection.cts`) spawns `gsd-core/bin/gsd-tools.cjs <family> [subcommand] ... --cwd <dir> --raw --json-errors` bounded and non-throwing, mirroring the precedent already established for the OpenCode/Kilo hook bridge (`.opencode/plugins/gsd-core.js`'s "Architecture: SUBPROCESS REUSE" header). The companion MCP server's `gsd_invoke_command` tool dispatches through the SAME shared helper (it had the identical `createHub()`-with-no-args bug). `/gsd`'s command handler is `handler(args, ctx)` (pi's real ExtensionAPI shape — a raw args string, not `execute(ctx)`); `gsd_invoke`'s tool handler is the real 5-arg `execute(toolCallId, params, signal, onUpdate, ctx)`. The event surface (`EXTENSION_EVENT_SURFACES.pi`, `src/host-integration.cts`) now declares the full ~30-event pi ExtensionAPI vocabulary (was a placeholder `['tool_call']`), and `pi/gsd.cjs` binds `session_start` (→ `gsd-ensure-canonical-path.js`), `before_agent_start` (→ `gsd-workflow-guard.js`, a forward-compatible no-op today since that hook's triggers are tool-scoped), `session_before_compact` (→ `gsd-context-monitor.js`), and `tool_call`, each as a bounded fail-open `spawnSync` subprocess (mirroring `.opencode/plugins/gsd-core.js`'s `runHook`). `modelMode: active` is realized via `pi.on('before_provider_request', ...)`, which resolves a tier through the model-catalog's now-populated `runtimeTierDefaults.pi` entries (bare anthropic ids — `claude-opus-4-8`/`claude-sonnet-5`/`claude-haiku-4-5`, matching the `claude` runtime's own ids since pi talks the anthropic API) and returns a modified payload, or `undefined` (fail-open, pi's model left untouched) when resolution comes back null — **not** `registerProvider`, which would register a new model provider rather than steering pi's existing built-in anthropic models.

**Adversarial-review correction (#2102 Stage 2, post-review):** the event bridges above and the `/gsd` tokenizer's `hooks/lib/git-cmd.js` require were DEAD in a real install — Stage 1's `hostBehaviors.skipSharedHooksInstall:true` meant pi shipped NO `hooks/` directory at all, so `runHook('gsd-ensure-canonical-path.js', ...)` etc. always hit the "hook file absent → silent no-op" branch, and the tokenizer always fell back to plain whitespace-splitting. The tests masked this because they run against the dev tree, where `hooks/` genuinely exists. **Fix:** `capabilities/pi/capability.json` no longer sets `skipSharedHooksInstall` — pi is architecturally identical to OpenCode here (`hooksSurface: "none"` + a native extension that spawns the staged hooks), not to Kilo/ZCode (`hooksSurface: "none"` with NO plugin surface, where the same hooks genuinely are dead weight). pi now installs `hooks/` + `hooks/lib/` (27 entries: the same `INSTALLED_HOOK_FILES` set OpenCode gets) alongside `extensions/gsd.js`, verified end-to-end via a real `node bin/install.js --pi --global`/`--local` — `resolveEngineRoot`'s walk-up from the installed extension's own directory finds `ENGINE_ROOT/hooks/{gsd-ensure-canonical-path.js,gsd-workflow-guard.js,gsd-context-monitor.js,lib/git-cmd.js}`, and each bridge/`runHook` call exits 0 against the real installed files. `hooksSurface: "none"` + `configFormat: "none"` + `writesSharedSettings: false` are unaffected — no settings/hooks.json/config.toml is written for pi; the extension spawns hooks by absolute path, not via a config-file hook bus. `tests/fixtures/golden-install-parity/pi.json` grew from 292 → 320 entries (the 28 new `hooks/`/`hooks/lib/` files); `commands/`, `agents/`, `skills/` remain absent (`pluginOnlyInstall` is untouched — it only gates the declarative-markdown surfaces, not hooks). `tests/install-minimal-hooks.test.cjs`'s #1821 suite moved pi from the Kilo/ZCode (no-hooks) group into the OpenCode (ships-hooks) group accordingly.

## vscode

> VS Code is the IDE-profile reference host: a Marketplace/VSIX-distributed extension, NOT
> file-projected onto a config directory — it has no `runtime.localConfigDir` in the usual sense
> (`configHome.kind: "none"`, `localConfigDir: null`) and no CLI install surface at all
> (`installSurface: "none"`; it is never installed by `bin/install.js` — no `--vscode` flag, no
> `allRuntimes` membership; see `capabilities/vscode/capability.json`). The extension IS the host.
> **Sourcing note:** the citations below are the VS Code extension API documentation pages named
> in ADR-1239 (#2103) as the source for each axis; this environment did not have live Context7/
> web-fetch access at authoring time, so the Evidence column is a paraphrase of VS Code's
> documented extension model rather than a verbatim excerpt — a maintainer with Context7/web
> access should verify the exact wording before treating this section as fully cited (same caveat
> already flagged for the pi section above).

| Axis | Value | Source | Evidence |
|---|---|---|---|
| embeddingMode | imperative | https://code.visualstudio.com/api/references/vscode-api | The extension is loaded in-process by the extension host and calls the `vscode` namespace API directly (`vscode.commands.registerCommand`, `vscode.chat.createChatParticipant`, `vscode.lm.registerTool`) — an in-process programmatic API, not a config-file-only integration. |
| commandSurface | palette | https://code.visualstudio.com/api/extension-guides/command | Commands are contributed via `contributes.commands` in package.json and registered with `vscode.commands.registerCommand`, surfaced through the Command Palette (and the Chat view via the chat participant) — not a markdown/TOML slash-command file format. |
| modelMode | active | https://code.visualstudio.com/api/extension-guides/ai/language-model | The `vscode.lm` namespace lets an extension actively select a model (`vscode.lm.selectChatModels`) and send requests to it programmatically, rather than only reading a static config value. |
| hookBus | engine | https://code.visualstudio.com/api/references/activation-events | VS Code has no cross-extension lifecycle-hook bus that GSD subscribes to; the extension host (the "engine" here, per this axis's own `host`/`engine`/`none` vocabulary) owns activation events, and GSD's own hook lifecycle runs fully in-process/engine-owned inside the extension. |
| stateIO | sandboxed-storage | https://code.visualstudio.com/api/references/vscode-api#Memento | `context.globalState`/`context.workspaceState` (both `Memento`) are the extension's persistent storage surface — sandboxed key/value storage scoped to the extension, not unrestricted local filesystem access. |
| transport | mcp | https://code.visualstudio.com/api/extension-guides/ai/mcp | VS Code 1.99 added native MCP client support; on the Web (webworker) entry, full GSD command dispatch is available through VS Code's native MCP client connecting to the GSD companion MCP server (`gsd-mcp-server`), not an in-process Node dispatch (which the web entry cannot run at all). |
| runtime | sandboxed-web | https://code.visualstudio.com/api/extension-guides/web-extensions | The `browser` entry point (`vscode/browser.js`) runs in a webworker context with no Node core modules — the Web Extension execution model VS Code documents for extensions that must run in vscode.dev/github.dev. |
| dispatch.namedDispatch | true | https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode#_agent-mode-tools | Registered `languageModelTools` (and the chat participant) are addressable by name — the primary agent references a tool/participant by its declared name/`toolReferenceName`, not only positionally. |
| dispatch.nested | true | https://code.visualstudio.com/docs/copilot/copilot-chat-agents (subagents) | VS Code's chat subagent model (`#runSubagent`) explicitly supports a subagent invoking further subagents, gated by `chat.subagents.allowInvocationsFromSubagents`. |
| dispatch.maxDepth | 5 | https://code.visualstudio.com/docs/copilot/copilot-chat-agents (subagents) | Documented as VS Code's maximum nesting depth for `#runSubagent` chains — also matches this repo's existing `PROFILE_BASELINES.ide.dispatch.maxDepth` baseline. |
| dispatch.background | true | https://code.visualstudio.com/api/extension-guides/ai/tools | Language Model Tools can be invoked as part of an asynchronous agent turn (the primary agent does not block synchronously on a single extension call). |
| dispatch.subagentToolkit | undocumented | no authoritative doc found at authoring time | VS Code's subagent documentation does not state whether a subagent's tool surface is restricted to read-only tools or the full set an extension registers; recorded `undocumented` (fails closed to `read-only` in negotiation) rather than guessed. |
| dispatch.backgroundDispatch | undocumented | no authoritative doc found at authoring time | Whether a background-dispatched subagent can itself spawn further NAMED subagents (the #853 discriminator) is not stated in the sources reviewed; recorded `undocumented` (fails closed to `false`) rather than guessed. |
| dispatch.isolation | undocumented | not researched / no concurrent fan-out documented for this axis | no authoritative source consulted for concurrent-executor isolation on this host — fails closed to `none` (sequential) in negotiation (#2584) |

Sources consulted:
- https://code.visualstudio.com/api/references/vscode-api
- https://code.visualstudio.com/api/extension-guides/command
- https://code.visualstudio.com/api/extension-guides/ai/language-model
- https://code.visualstudio.com/api/extension-guides/ai/tools
- https://code.visualstudio.com/api/extension-guides/ai/mcp
- https://code.visualstudio.com/api/extension-guides/web-extensions
- https://code.visualstudio.com/api/references/activation-events
- https://code.visualstudio.com/docs/copilot/copilot-chat-agents

Documentation gaps:
- dispatch.subagentToolkit / dispatch.backgroundDispatch — the reviewed sources document that
  `#runSubagent` exists (v1.105+, `chat.subagents.allowInvocationsFromSubagents`, max nesting
  depth 5) but do not state the subagent tool-restriction model or whether a background-dispatched
  subagent can itself spawn further named subagents; both stay `undocumented` and negotiation
  fails closed.
- This section's Evidence-column wording was authored without live Context7/web-fetch access (see
  the sourcing note above the table) — verify against the cited pages before relying on it for a
  future capability upgrade, same caveat as the pi section above.

EoS migration status (#2103): vscode lands as a registry runtime (role:runtime) for
validator/host-integration coverage ONLY — it is deliberately NOT a CLI-installable runtime
(`installSurface: "none"`, never in `bin/install.js`'s `allRuntimes`; see the
`NON_INSTALLABLE_RUNTIMES` carve-out in `tests/runtime-flags.test.cjs`). The extension surface
(`vscode/extension.js`, `vscode/browser.js`, `vscode/host-binding.js`, `vscode/package.json`) is
distributed via the Marketplace/VSIX, not `npx --vscode` — there is no `docs/how-to/install-on-
your-runtime.md` entry for it. Dispatch is SUBPROCESS REUSE on desktop (the same shared
`dispatchGsdCommand` in `gsd-core/bin/lib/shell-command-projection.cjs` the pi extension and the
companion MCP server use) via `vscode/extension.js`'s `main` entry (Node). The `browser` entry
(`vscode/browser.js`) is a SEPARATE, independently zero-Node-API file: it does NOT require
`host-binding.js` because that module's engine-lib dependencies (`state-io.cjs`,
`adapter-imperative.cjs` → `install-engine.cjs`/`capability-loader.cjs`,
`model-adapter.cjs` → `model-resolver.cjs` → `config-loader.cjs`/`configuration.cjs`) all pull in
Node's `fs`/`os`/`path` at module-load time — requiring any of them from a webworker context would
throw immediately. `browser.js` instead composes its own minimal surface directly against
`vscode.lm`, and its command/tool/chat handlers surface an honest "full dispatch is unavailable on
web; configure the GSD MCP server" message rather than a silent failure. The chat participant
(`@gsd`) and Language Model Tools (a representative 3-tool set — `gsd_progress`, `gsd_workstreams`,
`gsd_plan_phase` — matching real shipped skills that map onto a single, safe, read-only
`gsd-tools.cjs` command) are registered on BOTH entries identically; only the dispatch behavior
differs. `#runSubagent` wiring (`registerSubagentDispatch`/`dispatchAsSubagent`, gated on
`chat.subagents.allowInvocationsFromSubagents` availability, fail-soft on older/Insiders-gated
hosts) adds a belt-and-suspenders `maxDepth: 5` ceiling independent of whatever VS Code's own chat
engine enforces natively — there is no separate extension-side "subagent contribution"
registration API beyond the chat participant + Language Model Tools already registered; VS Code's
chat engine surfaces them to `#runSubagent` on its own.


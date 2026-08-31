# How to install GSD Core on your runtime

Install GSD Core (`@opengsd/gsd-core`) into the AI coding runtime you use every day. This guide gives you the standard installer path for each supported runtime, then covers the manual path for machines without Node.js.

**What you need:** Node.js 18+ and npm (or npx). If you do not have Node.js, jump to [Installing without Node.js](#installing-without-nodejs).

---

## Why the installer is required

GSD Core ships agent and command files in Claude Code's native frontmatter format. Each supported runtime expects a different schema, directory layout, and command-invocation syntax. The installer performs the necessary transformations — for example, converting tool lists and colour values for OpenCode and writing TOML agent entries for Codex.

**Do not copy files from `agents/` or `commands/` directly.** Doing so bypasses the transformations and produces schema-validation errors or missing commands.

---

## Standard install

Run the installer from any directory. It prompts for your runtime and whether to install globally (all projects) or locally (this project only).

```bash
npx @opengsd/gsd-core@latest
```

That is the only command you need for a fresh install or to re-run the installer after switching runtimes.

---

## Per-runtime instructions

### Claude Code

```bash
npx @opengsd/gsd-core@latest --claude --global
```

Skills land in `~/.claude/`. Commands appear as `/gsd-*` slash commands in your next Claude Code session. Restart Claude Code to pick them up.

**Installing at both `--global` and `--local`.** This is a supported configuration (different projects sometimes need different customizations), but Claude Code's own trigger-resolution rules — personal scope overrides project scope, and a skill overrides a same-named command — both point the same direction: the global skill always wins the `/gsd-<name>` trigger over the local command. GSD Core detects this and prints which scope is winning right after install completes (and surfaces the identical fact from `/gsd-health` as diagnostic `W028`); it is an advisory, not a failure — the install itself still succeeds. At **global** scope, the winning skill's workflow-spec reference resolves at runtime against your working directory first, so a project with its own `.claude/gsd-core/` still gets its own specs even though the global skill is what Claude Code invokes — see [Interpret install-shadow warnings](interpret-install-shadow-warnings.md) for what the warning means, how to read which scope wins, and the limits of that resolution (it does not extend to the skill's `references/`/`templates/` includes).

**Override the install directory:**

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt npx @opengsd/gsd-core@latest --claude --global
```

**Hook coverage**

GSD registers the following Claude Code hook events automatically on install:

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | `gsd-check-update.js`, `gsd-session-state.sh` | Update check, session orientation |
| `PostToolUse` | `gsd-context-monitor.js`, `gsd-read-injection-scanner.js`, `gsd-phase-boundary.sh`, `gsd-graphify-update.sh` | Context monitoring, read-time scan, phase boundary detection |
| `PreToolUse` | `gsd-prompt-guard.js`, `gsd-read-guard.js`, `gsd-workflow-guard.js`, `gsd-worktree-path-guard.js`, `gsd-agent-isolation-guard.js`, `gsd-validate-commit.sh` | Prompt guard, read-before-edit, workflow + worktree safety, agent-dispatch isolation, commit validation |
| `SubagentStop` | `gsd-context-monitor.js` | Context headroom tracking after subagent completion |
| `Stop` | `gsd-context-monitor.js` | Context headroom tracking before model stop |
| `PreCompact` | `gsd-context-monitor.js` | Context awareness before conversation compaction |
| `FileChanged` (matcher: `config.json`) | `gsd-config-reload.js` | Hot-reloads `.planning/config.json` context mid-session when you edit your GSD config — no session restart required |

The `FileChanged` hook is always-on and a no-op when `.planning/config.json` does not exist in the project. Editing that file while a session is running injects an `additionalContext` summary of the new configuration so the agent picks up model overrides, workflow toggles, and hook settings immediately.

---

### Claude Code — native plugin install

GSD Core ships a `.claude-plugin/plugin.json` manifest, which enables installation and lifecycle management through the Claude Code plugin system. This path is **additive** — the npm installer above remains fully supported, and the two approaches differ in namespace and lifecycle only.

**Install paths**

*Option A — marketplace or git install (once listed):*

```bash
claude plugin install gsd-core
```

*Option B — zero-friction skills-dir load:* Claude Code automatically discovers any directory under `~/.claude/skills/` that contains a `.claude-plugin/plugin.json` as a plugin. To use gsd-core this way, place (or symlink) the gsd-core package directory there:

```bash
# Example: place the package under ~/.claude/skills/gsd-core/
# Claude Code loads it as gsd-core@skills-dir on the next session start.
# No explicit install step required.
```

**Command namespace**

Plugin commands are namespaced as `/gsd-core:<command>` — for example, `/gsd-core:plan-phase`. This is distinct from the classic npm/file-copy installer, which exposes commands as `/gsd:<command>`. Use whichever namespace corresponds to your install method.

**Lifecycle**

```bash
claude plugin enable gsd-core
claude plugin disable gsd-core
claude plugin update gsd-core
```

**Hooks**

The plugin wires gsd-core's always-on guard and update hooks automatically via `hooks/hooks.json`. No manual hook registration is required.

**Prerequisites**

The `gsd-tools` binary (installed as part of the `@opengsd/gsd-core` npm package) must be available on your `PATH` for gsd commands to execute their backing logic. The plugin delivers the command, agent, and hook surface; the npm package delivers the runtime CLI.

Node.js (`node`) must also be available on your `PATH`. The plugin's always-on guard hooks (wired in `hooks/hooks.json`) are invoked as `node "${CLAUDE_PLUGIN_ROOT}/hooks/<script>"`. Some Claude Code distributions ship as a standalone binary and do not expose a `node` executable on `PATH`; in those environments the plugin's hooks will not run. Verify with `node --version` before relying on the plugin hooks.

**Runtime build (self-healing).** The runtime CLI's compiled modules under `gsd-core/bin/lib/*.cjs` are build artifacts (ADR-457): they are compiled from `src/*.cts` by `npm run build:lib` and shipped prebuilt in the npm tarball. A plugin-marketplace or git-clone install materializes the repository tree directly and never runs that build step, so those files are initially absent. The CLI heals this automatically: the first `gsd-tools` invocation detects the missing output and compiles it once (using the bundled `typescript` devDependency), then proceeds normally. You may see a one-time `gsd: runtime library not built — compiling once…` notice on stderr; subsequent commands are unaffected. If auto-build cannot run (for example `node_modules` was pruned to production-only and `typescript` is unavailable), the CLI prints an actionable message telling you to run `npm install && npm run build:lib` in the plugin directory.

#### Claude plugin marketplace discovery (ZCODE and compatible runtimes)

GSD Core also ships a `.claude-plugin/marketplace.json` marketplace manifest (sibling to `plugin.json`). Runtimes that implement the Claude plugin marketplace contract — such as ZCODE — can discover and install GSD Core from a custom marketplace source without a manual clone:

1. In your runtime's plugin UI, add a custom marketplace source pointing at `open-gsd/gsd-core` (GitHub `owner/repo` form).
2. GSD Core appears in the catalog and can be installed directly from the UI.

This path is **additive** and changes nothing about the Claude Code plugin install above (`.claude-plugin/plugin.json` is unchanged). The marketplace entry's `source` is `./`, so it reuses `plugin.json`'s `commands` / `skills` / `hooks` mapping. The catalog version tracks `package.json` (it lives at `plugins[0].version` and is stamped by the release version-sync), so the version you see in the marketplace matches the npm release.

---

### OpenCode

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

The installer writes four surfaces under `~/.config/opencode/` (XDG) or `~/.opencode/`: flat slash commands in `commands/` (plural — the directory OpenCode discovers slash commands from, #2329), file-based subagents in `agents/`, on-demand skills in `skills/<name>/SKILL.md`, and a native plugin in `plugins/gsd-core.js`. It converts agent frontmatter to OpenCode's schema — removing the `tools:` field and converting colour values to hex — and emits each skill with spec-compliant frontmatter (`name` matching the skill directory plus a `description`). Skills are loaded on demand via OpenCode's native skill tool; commands remain invokable as `/gsd-*`. See [Installing without Node.js — OpenCode transformations](#opencode--required-transformations) if you need to understand what changes.

**GSD safety hooks on OpenCode.** OpenCode does not register lifecycle hooks the way Claude Code does (its `hooksSurface` is `none`), so GSD's prompt-injection guard, read-before-edit guard, injection scanner, and context monitor would otherwise be inert. The bundled plugin (`plugins/gsd-core.js`) closes that gap: OpenCode auto-discovers `plugins/*.{ts,js}` files under its config directory at startup and the adapter bridges OpenCode's event bus (`tool.execute.before`/`after`, `session.created`, `file.edited`) onto GSD's existing hook scripts, spawning them as subprocesses. No `opencode.json` entry is needed — the plugin is loaded by directory auto-discovery (the config `plugin` array is for npm packages only). A blocking hook aborts the tool call; an advisory hook surfaces its message without blocking.

**Your plugin directory is pinned to CommonJS (accepted trade-off, #2544).** GSD's adapter is a CommonJS `.js` file, and Node decides a `.js` file's module type by walking up for the nearest `package.json`. So the installer writes a minimal `{"type":"commonjs"}` marker into the plugin directory itself — `plugins/package.json` on OpenCode and Kilo, `extensions/package.json` on pi. It is written only when GSD actually stages its adapter there, it never overwrites a `package.json` GSD did not write, and uninstall removes only its own.

The trade-off: that marker shadows your config root for **every** `.js` file in that directory, not just GSD's. If you author your own plugins as ESM `.js` and rely on a `"type": "module"` at the config root, they will stop resolving as ESM. This is deliberate — it is strictly narrower than the pre-#2544 behavior, which wrote the marker over `<configRoot>/package.json` itself and destroyed whatever was there — but it is a real constraint rather than a pure improvement, which is why it is stated here.

**Mitigation:** author your own plugins as `.ts`. OpenCode and Kilo compile plugin TypeScript with Bun, and a `package.json` `type` field does not affect `.ts` resolution — so a `.ts` plugin is unaffected by the marker. Failing that, keep ESM plugins outside the auto-discovered directory and load them as npm packages via the config `plugin` array.

**Override the install directory:**

```bash
OPENCODE_CONFIG_DIR=~/.config/opencode-alt npx @opengsd/gsd-core@latest --opencode --global
```

---

### Kilo

```bash
npx @opengsd/gsd-core@latest --kilo --global
```

The installer writes the same three surfaces under `~/.config/kilo/` (XDG) or `~/.kilo/` as for OpenCode — flat commands in `command/`, subagents in `agents/`, and skills in `skills/<name>/SKILL.md` — since Kilo derives from OpenCode and shares its config schema and skill layout.

**Override the install directory:**

```bash
KILO_CONFIG_DIR=~/.config/kilo-alt npx @opengsd/gsd-core@latest --kilo --global
```

---

### Codex

```bash
npx @opengsd/gsd-core@latest --codex --global
```

Skills land in `~/.codex/skills/gsd-*/SKILL.md`. Agents are written as standalone `~/.codex/agents/gsd-*.toml` files, which Codex auto-discovers — that is the sole registration source for each role; `config.toml` only carries the shared `[agents]` dispatch-tuning scalar (`max_depth`), not a per-role table (#2406). Restart Codex (or run `codex --reload`) after install.

**Minimum supported version:** Codex CLI 0.130.0. Earlier versions had additional skill-root scanning that can produce duplicate listings.

**Hook coverage**

GSD registers the following Codex hook events automatically on install (requires Codex CLI 0.137.0+ for the stable hook-event schema):

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | `gsd-check-update.js` | Update check at session open; Windows installs also emit a `commandWindows` field pointing to the `.cmd` shim so Codex picks the correct executor on Windows without requiring per-OS config regeneration |
| `SubagentStart` | `gsd-context-monitor.js` | Inject context / GSD_AGENT_NAME awareness at subagent open |
| `Stop` | `gsd-context-monitor.js` | Context headroom tracking before model stop |
| `PostToolUse` | `gsd-context-monitor.js` | Mirror the context-monitor coverage available in Claude Code |

All registered hooks are managed by GSD and are removed cleanly on `--uninstall`.

---

### Kimi CLI

> **Support boundary — legacy `kimi-cli` vs Kimi Code.** This integration targets the legacy/Python `kimi-cli` custom-agent contract. The `kimi --agent-file <configRoot>/agents/gsd.yaml` launch shown below is accepted by `kimi-cli`. The newer npm Kimi Code (`@moonshot-ai/kimi-code`, e.g. `0.11.0`) does **not** accept `--agent-file`; it discovers skills through fixed skill roots and `--skills-dir`. The generated `/skill:gsd-*` skills work in both, but the custom-agent (`--agent-file`) surface is specific to legacy `kimi-cli`. For Kimi Code, point it at the installed skills root with `--skills-dir <configRoot>/skills` instead of using `--agent-file`.

```bash
npx @opengsd/gsd-core@latest --kimi --global
```

Skills land in Kimi's first existing generic user skills root:

- `~/.config/agents/skills/gsd-*/SKILL.md` when `~/.config/agents/skills` already exists, or when neither generic root exists yet
- `~/.agents/skills/gsd-*/SKILL.md` when `~/.agents/skills` already exists and `~/.config/agents/skills` does not

Start a new Kimi CLI session after install, then invoke GSD skills with `/skill:gsd-*`, for example:

```text
/skill:gsd-new-project
```

The installer also writes the GSD custom agent definition to the same selected config root: `<configRoot>/agents/gsd.yaml` with its prompt at `<configRoot>/agents/gsd.md`; subagents land under `<configRoot>/agents/subagents/gsd-*.yaml` and `<configRoot>/agents/subagents/gsd-*.md`.

Kimi custom agents do not auto-activate just because the files exist. Launch Kimi with the generated agent file when you want the GSD agent surface:

```bash
kimi --agent-file ~/.config/agents/agents/gsd.yaml
```

If your machine already uses `~/.agents/skills` and does not have `~/.config/agents/skills`, GSD installs there instead and the launch command becomes:

```bash
kimi --agent-file ~/.agents/agents/gsd.yaml
```

> **If you are on Kimi Code, use `--kimi-code`, not `--kimi` with a redirected config dir.** Since 1.10.0 (#2755) Kimi Code is its own runtime with its own hooks root:
>
> ```bash
> npx @opengsd/gsd-core@latest --kimi-code --global
> ```
>
> `--config-dir` and `KIMI_CONFIG_DIR` select the *skills* root only. They do **not** move the native `config.toml` that carries GSD's `[[hooks]]` block — that root is chosen by the runtime (`~/.kimi` for `--kimi` via `KIMI_SHARE_DIR`, `~/.kimi-code` for `--kimi-code` via `KIMI_CODE_HOME`). Running `--kimi --config-dir ~/.kimi-code` therefore puts your skills under `~/.kimi-code` while the hooks still land in `~/.kimi` — the exact split that left orphaned hooks behind before 1.10.0. See [Migrating from `--kimi` to `--kimi-code`](../migration/kimi-to-kimi-code.md), which also covers reclaiming artifacts an older install already wrote.

Kimi CLI also discovers user skills from the brand-specific `~/.kimi-code` directory. If you are genuinely on **Kimi CLI** and your setup is centered on `~/.kimi-code`, redirect its skills root explicitly:

```bash
npx @opengsd/gsd-core@latest --kimi --global --config-dir ~/.kimi-code
```

Then launch the generated agent from that directory:

```bash
kimi --agent-file ~/.kimi-code/agents/gsd.yaml
```

For brand-specific scripted installs, use:

```bash
KIMI_CONFIG_DIR=~/.kimi-code npx @opengsd/gsd-core@latest --kimi --global
```

Avoid arbitrary `KIMI_CONFIG_DIR` roots unless your Kimi configuration also adds the matching `skills/` directory to Kimi's extra skill directories. GSD can write files there, but Kimi will not auto-discover skills outside its documented generic and brand-specific roots without that Kimi-side configuration.

`--kimi --local` is intentionally deferred and guarded in v1; use the global install path above for Kimi CLI.

**Hook coverage**

GSD wires its lifecycle hooks into Kimi's native `[[hooks]]` array in `config.toml` — by default `~/.kimi/config.toml` (overridable via Kimi's own `KIMI_SHARE_DIR` environment variable, a directory deliberately separate from the `~/.config/agents` skills root above). Kimi CLI's hooks system is documented as **Beta**. GSD's entries are wrapped in `# GSD Hooks BEGIN`/`# GSD Hooks END` marker comments, so reinstalling only ever rewrites GSD's own block and never touches hand-written `[[hooks]]` entries around it.

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | `gsd-check-update.js`, `gsd-session-state.sh` | Update check and session-state bootstrap at session open |
| `PreToolUse` | `gsd-prompt-guard.js`, `gsd-read-guard.js`, `gsd-worktree-path-guard.js`, `gsd-workflow-guard.js`, `gsd-validate-commit.sh` | Prompt-injection guard, read-before-edit guidance, worktree path safety, workflow guard, and commit validation before tool calls |
| `PostToolUse` | `gsd-context-monitor.js`, `gsd-phase-boundary.sh`, `gsd-read-injection-scanner.js`, `gsd-graphify-update.sh` | Context window tracking, phase-boundary detection, read-time injection scanning, and graph updates after tool calls |
| `Stop` | `gsd-context-monitor.js` | Context headroom tracking before the model stops |
| `PreCompact` | `gsd-context-monitor.js` | Context headroom tracking before compaction |
| `SubagentStart` | `gsd-context-monitor.js` | Inject context / GSD_AGENT_NAME awareness at subagent open |
| `SubagentStop` | `gsd-context-monitor.js` | Context headroom tracking at subagent stop |

All registered hooks are managed by GSD and are removed cleanly on `--uninstall`.

---

### GitHub Copilot

```bash
npx @opengsd/gsd-core@latest --copilot --global
```

Skills land in `~/.copilot/`. GSD installs as agent `.md` files and repository instruction files.

GSD also wires Copilot's lifecycle hooks and instruction files:

- **`AGENTS.md`** (local installs) — written at the repository root, which GitHub Copilot CLI reads as primary instructions, alongside `copilot-instructions.md`.
- **Lifecycle hook** — a `sessionStart` hook config is written to `.github/hooks/gsd-session.json` (local) or `~/.copilot/hooks/gsd-session.json` (global). It is a self-contained inline `command` hook (no separate hook script to install), so it can never reference a missing script. The hook is advisory-only: at session start it surfaces whether the project has a `.planning/` workflow.

Both are removed (and any user-authored content preserved) on `--uninstall`.

**Override the install directory:**

```bash
COPILOT_CONFIG_DIR=~/.copilot-alt npx @opengsd/gsd-core@latest --copilot --global
```

---

### Cursor

```bash
npx @opengsd/gsd-core@latest --cursor --global
```

Artifacts land in `~/.cursor/`. GSD installs skills (`~/.cursor/skills/gsd-*/SKILL.md`), agents, and rule references. Cursor exposes each skill once in the `/` menu while keeping it available for contextual model invocation. Upgrading removes manifest-managed legacy `~/.cursor/commands/gsd-*.md` copies that previously duplicated those menu entries; unknown user-authored command files are preserved.

**Override the install directory:**

```bash
CURSOR_CONFIG_DIR=~/.cursor-alt npx @opengsd/gsd-core@latest --cursor --global
```

---

### Windsurf / Devin Desktop

Windsurf has rebranded to **Devin Desktop**. Both runtime names are accepted — use either `--windsurf` or `--devin-desktop`.

```bash
npx @opengsd/gsd-core@latest --windsurf --global
# or equivalently:
npx @opengsd/gsd-core@latest --devin-desktop --global
```

Use a workspace install for Windsurf slash commands. Workspace installs write `/gsd-*` commands as Windsurf workflow files under `.windsurf/workflows/`. Windsurf discovers those `.md` workflow files in Cascade and exposes them through the `/` menu. Global-scope Windsurf workflow installation is intentionally a no-op for now because global workflow locations are outside GSD's normal user-owned runtime config directory.

**Override the install directory:**

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-alt npx @opengsd/gsd-core@latest --windsurf --global
```

---

### Cline

GSD gives Cline both skills (≥ v3.48.0) and the `.clinerules/` directory integration — no custom slash commands are registered.

```bash
# Global install (all projects — skills + rules directory)
npx @opengsd/gsd-core@latest --cline --global

# Local install (this project only — rules directory only)
npx @opengsd/gsd-core@latest --cline --local
```

GSD writes the [`.clinerules/` directory form](https://docs.cline.bot/customization/cline-rules):

- **`.clinerules/gsd.md`** — the GSD rule file. Cline loads every `.md`/`.txt` file in
  the `.clinerules/` directory automatically; no custom slash commands are registered.
- **`.clinerules/hooks/PreToolUse`** — a [lifecycle hook](https://cline.bot/blog/cline-v3-36-hooks)
  (Cline v3.36+). It is an executable script that receives the tool-call context as JSON on
  stdin and returns a JSON decision (`cancel` / `errorMessage` / `contextModification`). The
  GSD hook guards `.planning/` artifacts from direct edits and otherwise allows the operation;
  it fails open, so a hook error never blocks you. Cline runs hooks on macOS and Linux only.

**Global install additionally:**

- Emits each GSD command as **`~/.cline/skills/<name>/SKILL.md`**. Cline ≥ v3.48.0 loads
  skills from `~/.cline/skills/` automatically — no configuration needed.
- Merges GSD instructions into **`~/.agents/AGENTS.md`**, the cross-tool global instruction
  file Cline reads. The block is marker-delimited, so your own `AGENTS.md` content (and other
  tools' entries) is preserved, and `--uninstall` strips only the GSD block.

**Local install** writes the `.clinerules/` directory into the current project only. No skills
directory is created for local scope.

> Cline's *global* hook directory (`~/Documents/Cline/Rules/Hooks/`) is not yet populated by the
> installer — project-scope hooks (`.clinerules/hooks/`) and the global `AGENTS.md` instruction
> target cover the common cases.

---

### CodeBuddy

```bash
npx @opengsd/gsd-core@latest --codebuddy --global
```

GSD installs four surfaces. Slash command definitions land in `~/.codebuddy/commands/gsd-*.md` and appear as `/gsd-help`, `/gsd-phase`, `/gsd-ship`, etc. in the `/` menu. Subagents land in `~/.codebuddy/agents/gsd-*.md`. Skills land in `~/.codebuddy/skills/gsd-*/SKILL.md` — emitted with `user-invocable: false` so they stay out of the `/` menu (the commands surface is the sole `/` entry point) and remain available for model invocation. CodeBuddy hooks are written to `settings.json`. No `mcp.json` is written: GSD ships no MCP server.

**Hook coverage**

GSD registers the following events automatically on install (Claude hook event dialect):

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | `gsd-check-update.js`, `gsd-session-state.sh` | Update check, session orientation |
| `PreToolUse` | `gsd-prompt-guard.js`, `gsd-read-guard.js`, `gsd-workflow-guard.js`, `gsd-worktree-path-guard.js`, `gsd-agent-isolation-guard.js`, `gsd-validate-commit.sh` | Prompt guard, read-before-edit, workflow + worktree safety, agent-dispatch isolation, commit validation |
| `PostToolUse` | `gsd-context-monitor.js`, `gsd-read-injection-scanner.js`, `gsd-phase-boundary.sh`, `gsd-graphify-update.sh` | Context monitoring, read-time scan, phase boundary detection |
| `SubagentStop` | `gsd-context-monitor.js` | Context headroom tracking after subagent completion |
| `SubagentStart` | `gsd-context-monitor.js` | Context headroom tracking at subagent start |
| `Stop` | `gsd-context-monitor.js` | Context headroom tracking before model stop |
| `PreCompact` | `gsd-context-monitor.js` | Context awareness before conversation compaction |

CodeBuddy's own [background sub-agent dispatch](https://www.codebuddy.ai/docs/cli/sub-agents) (`run_in_background: true`) is a caller-side invocation parameter, not something GSD's installed agent files control — there is no frontmatter field to set on GSD's agent artifacts to request it.

---

### Qwen Code

Qwen Code uses the same open skills standard as Claude Code 2.1.88+.

```bash
npx @opengsd/gsd-core@latest --qwen --global
```

Skills land in `~/.qwen/skills/gsd-*/SKILL.md`.

GSD's main-loop skills are emitted with Qwen's optional numeric `priority` frontmatter field so the most-used workflows surface first in the `/skills` TUI list. Higher values sort earlier (per Qwen's skills spec), so core commands such as `/skills` for `new-project` (100), `plan-phase` (90), and `execute-phase` (85) appear above utility skills, which are left unset (default 0). This affects only the `/skills` list order — slash-command completion and `/help` remain alphabetical.

Subagents land in `~/.qwen/agents/gsd-*.md` as native Qwen subagents, converted to Qwen's own `name:`/`description:`/`tools:` (YAML block list) frontmatter schema rather than Claude Code's.

**Override the install directory:**

```bash
QWEN_CONFIG_DIR=~/.qwen-alt npx @opengsd/gsd-core@latest --qwen --global
```

**Hook coverage**

Qwen Code supports 15 hook events. GSD registers the following events automatically on install:

| Event | Hook | Purpose |
|---|---|---|
| `SessionStart` | `gsd-check-update.js`, `gsd-session-state.sh` | Update check, session orientation |
| `PostToolUse` | `gsd-context-monitor.js`, `gsd-read-injection-scanner.js`, `gsd-phase-boundary.sh`, `gsd-graphify-update.sh` | Context monitoring, read-time scan, phase boundary detection |
| `PreToolUse` | `gsd-prompt-guard.js`, `gsd-read-guard.js`, `gsd-workflow-guard.js`, `gsd-worktree-path-guard.js`, `gsd-agent-isolation-guard.js`, `gsd-validate-commit.sh` | Prompt guard, read-before-edit, workflow + worktree safety, agent-dispatch isolation, commit validation |
| `SubagentStop` | `gsd-context-monitor.js` | Context headroom tracking after subagent completion |
| `SubagentStart` | `gsd-context-monitor.js` | Context headroom tracking at subagent start |
| `Stop` | `gsd-context-monitor.js` | Context headroom tracking before model stop |
| `PreCompact` | `gsd-context-monitor.js` | Context awareness before conversation compaction |

---

### Augment Code

```bash
npx @opengsd/gsd-core@latest --augment --global
```

Skills land in `~/.augment/skills/` and slash command definitions land in `~/.augment/commands/`. GSD installs skills, agents, and commands (`/gsd-phase`, `/gsd-ship`, etc.). GSD's managed lifecycle hooks are registered into Augment's own `settings.json` `hooks` block (Claude hook event dialect, covering session-start, tool-use, and phase-boundary events) — no statusline ownership. #2097 also registers the GSD companion MCP server under `settings.json`'s `mcpServers.gsd` (see [Connect a host to the GSD MCP server](connect-gsd-mcp-server.md)).

---

### Antigravity

```bash
npx @opengsd/gsd-core@latest --antigravity --global
```

The installer auto-detects the Antigravity config directory (`~/.gemini/antigravity`, `~/.gemini/antigravity-ide`, or `~/.gemini/antigravity-cli`). Uses Gemini-compatible settings policy. Global skills and agents install under `~/.gemini/config/skills/` and `~/.gemini/config/agents/` — the directories Antigravity scans for machine-local discovery (#3738); the config directory above holds settings and GSD's runtime files.

**Override the install directory:**

```bash
ANTIGRAVITY_CONFIG_DIR=~/.gemini/antigravity-alt npx @opengsd/gsd-core@latest --antigravity --global
```

---

### Trae

```bash
npx @opengsd/gsd-core@latest --trae --global
```

Skills land in `~/.trae/`. GSD installs skills, agents, and rule references.

---

### ZCode

```bash
npx @opengsd/gsd-core@latest --zcode --global
```

[ZCode](https://zcode.z.ai/en) is Z.ai's desktop Agentic Development Environment for the GLM-5.2 model. GSD installs skills (nested `SKILL.md` bundles), slash commands, and subagents under `~/.zcode/`:

- **Skills** → `~/.zcode/skills/gsd-<name>/SKILL.md` (invoke with `$gsd-<name>` in chat)
- **Commands** → `~/.zcode/commands/gsd-<name>.md` (invoke with `/gsd-<name>`)
- **Subagents** → `~/.zcode/agents/gsd-<name>.md`

ZCode's skill format is identical to Claude Code's, so no runtime-specific converter is required — GSD lands as a pure declarative descriptor with no hardcoded installer branches. ZCode also natively imports skills and MCP config from `~/.claude`; if you install GSD for **both** Claude and ZCode, you may see duplicate GSD skills inside ZCode, which is expected. To connect ZCode's MCP servers to GSD's companion server, see [how to connect the GSD MCP server](connect-gsd-mcp-server.md).

GSD's hook-automation and native-MCP-registration integrations are not yet wired for ZCode — both are blocked on ZCode not yet publishing the on-disk config format for its plugin `Hook` component or the settings filename/schema for its MCP store. See the [`## zcode`](../reference/host-integration-capability-matrix.md#zcode) section of the host-integration capability matrix for the cited source URLs.

---

### pi

```bash
npx @opengsd/gsd-core@latest --pi --global
```

**Override the install directory:**

```bash
PI_CODING_AGENT_DIR=~/.pi-alt/agent npx @opengsd/gsd-core@latest --pi --global
```

`PI_CODING_AGENT_DIR` is pi's own upstream override (`getAgentDir()` in pi's `config.ts`) for its global agent directory (`~/.pi/agent` by default) — GSD honors it so the install always lands where pi actually reads ([#3023](https://github.com/open-gsd/gsd-core/issues/3023)). pi also supports a `piConfig.configDir` field (`config.ts`'s `CONFIG_DIR_NAME`) that renames the `.pi` segment, but that field is read from pi's own installed `package.json`, not your project's — it is a white-label/rebranding hook for redistributed pi forks (it sits beside `piConfig.name`, which renames the app itself), not something an end user sets for their own project. GSD's pi descriptor does not target rebranded forks, so `PI_CODING_AGENT_DIR` remains the correct override for a stock pi install.

[pi](https://pi.dev) is a bun-runtime programmatic CLI whose extensions implement pi's own `ExtensionAPI` (`registerCommand`/`registerTool`/`registerProvider`/`pi.on`) rather than a settings-file or slash-markdown surface. GSD ships a single native-extension file:

- **Extension** → `~/.pi/agent/extensions/gsd.js` (global) or `.pi/extensions/gsd.js` (local)

The `.js` suffix is load-bearing: pi auto-discovers extensions by scanning that directory and keeping only names ending in `.ts` or `.js`, and it skips anything else **silently** — no error, no log line. GSD shipped the file as `gsd.cjs` through 1.7.0, which pi therefore never loaded, so `/gsd` never appeared ([#2470](https://github.com/open-gsd/gsd-core/issues/2470)). Upgrading removes the stale `gsd.cjs`; if you had added a manual `extensions` entry in `~/.pi/agent/settings.json` as a workaround, you can drop it.

The extension registers a `/gsd` command and a `gsd_invoke` tool that dispatch GSD commands via a bounded subprocess call to `gsd-core/bin/gsd-tools.cjs` (no fully-populated in-process command-routing hub exists — see the matrix's Stage 2 note). This is a **plugin-only install**: pi has no shared-settings hook surface (`hooksSurface: none`) and, unlike Claude/OpenCode/Kilo, no host-read markdown surface at all — pi's `/gsd` command is registered programmatically by the extension, not discovered from files, so GSD installs the extension plus its universal `gsd-core/` engine payload and the shared `gsd-hooks/`/`gsd-hooks/lib/` bundle (spawned by the extension itself, not by any config-file hook bus), and does **not** write any `commands/`, `agents/`, or `skills/` directory for pi. The bundle lands under `gsd-hooks/` rather than the `hooks/` name every other runtime uses because pi reserves `hooks/` for its own deprecated extension directory and warns on startup whenever that directory merely exists ([#3023](https://github.com/open-gsd/gsd-core/issues/3023)). The extension bridges GSD's `session_start`/`before_agent_start`/`session_before_compact`/`tool_call` lifecycle events to those staged `gsd-hooks/` scripts as bounded, fail-open subprocesses, and steers pi's active model (`modelMode: active`) to a tier-resolved bare anthropic id via `pi.on('before_provider_request', ...)`. See the [`## pi`](../reference/host-integration-capability-matrix.md#pi) section of the host-integration capability matrix for the negotiated axes and citations.

---

## Local vs global install

All examples above use `--global`, which installs GSD once for your user account. To scope an install to a single project, replace `--global` with `--local`:

```bash
npx @opengsd/gsd-core@latest --claude --local
```

A local install writes into the `.claude/` directory at your project root. Local install settings take precedence over global ones when both exist.

---

## Installing prerelease editions (Next / Nightly / Insiders / Preview)

Prerelease editions of runtimes (Windsurf Next / Devin Desktop Next, Cursor Nightly, VS Code Insiders, Codex preview channels, etc.) read from a sibling config directory. Set the matching `*_CONFIG_DIR` env var before running the installer:

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

Select the corresponding stable runtime in the installer prompt. GSD does not enumerate prerelease editions as separate named runtimes — they are best-effort via this env-var mechanism and are not separately tested in release CI.

---

## Sharing one config root across environments

When one config root (`~/.claude`, `~/.config/opencode`, …) is mounted or synced into
machines with different Node.js layouts — a host plus Docker containers bind-mounting the
same directory, or WSL and Windows sharing a drive — install with `--portable-hooks`
(or `GSD_PORTABLE_HOOKS=1`):

```bash
npx @opengsd/gsd-core@latest --claude --global --portable-hooks
```

Hook script paths are emitted `$HOME`-relative, and every managed JavaScript hook command
resolves its node binary at hook-fire time instead of depending on whichever machine ran
the installer (#3662): portable installs route through a staged
`hooks/gsd-node-runner.sh` resolver (the install-time node path first, then `command -v
node`, then the well-known layouts); non-portable installs carry an equivalent inline
fallback chain. The install-time path is always tried first, so GUI launches with a
minimal `PATH` keep working, and a bare `node` lookup is never depended on. Re-running
install or update from any of the environments converges stale runner paths — no mixed
state where some hooks work in one environment and the rest in another.

To pin down which node a given environment picks, run the resolver directly with
`GSD_NODE_RUNNER_NO_FALLBACKS=1` (first-argument-only resolution) — it prints a stderr
diagnostic and exits non-zero when nothing resolves.

---

## Installing without Node.js

If you cannot run `npx` (for example, on a Windows machine without Node.js), you have two options.

**Option A — Use a machine that has Node.js.** Any machine with Node.js will do: WSL, a Linux VM, a CI runner, or a Docker container. Run the installer there, then copy the output directory to your target machine. For OpenCode:

```bash
npx @opengsd/gsd-core@latest --opencode --global
# Then copy ~/.config/opencode/agents/ to the Windows machine
```

**Option B — Manually transform the source files.** The agent source files live in `agents/` in the GSD Core repository and are in Claude Code's native frontmatter format. Each runtime expects a different shape. For the exact field transformations per runtime, see [Manual install / no-Node.js setup](../USER-GUIDE.md#manual-install--no-nodejs-setup) in the User Guide, which covers the OpenCode transformations in full detail and points to the installer's `convert*Frontmatter` functions for other runtimes.

---

## After install

Restart your runtime to pick up new commands and agents. Then start a new project or onboard an existing repo:

```bash
/gsd-new-project   # greenfield project
/gsd-onboard       # existing codebase
```

If the command is not found after restart, verify the install directory matches the runtime's expected config path. The prerelease-editions section above covers the most common mismatch.

### "… is not on your PATH" after install

If the installer's global bin directory is not on your `PATH`, it prints a one-time warning with a copy-paste command for your shell. The suggestion list covers `zsh`, `bash`, and `fish` (plus PowerShell, cmd.exe, and Git Bash on Windows). For fish, run the line it prints:

```fish
fish_add_path -- '/path/to/global/bin'
```

If the directory is already on your PATH but the installer still warns, open a new fish session (`exec fish`) to pick up the change.

---

## Related

- [Your first project](../tutorials/your-first-project.md)
- [Update GSD Core](update-gsd.md)
- [Configuration](../CONFIGURATION.md)
- [Docs index](../README.md)

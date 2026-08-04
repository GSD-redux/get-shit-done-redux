# Per-runtime skill mapping matrix

> **Reference** page. The authoritative source for every cell is the runtime's `capabilities/<runtime>/capability.json` `artifactLayout` descriptor, resolved by `resolveRuntimeArtifactLayout` in `gsd-core/src/runtime-artifact-layout.cts`. This page is the human-readable projection; when they disagree, the descriptor wins.
>
> **Decision record:** [ADR-1593 — Skill mapping & converter methodology across runtimes](../adr/1593-skill-mapping-converter-methodology.md). See also [ADR-3660](../adr/3660-runtime-artifact-layout-module.md) (layout owner) and [ADR-1016](../adr/1016-runtime-capability-descriptor.md) (converter enum).

## How to read this matrix

GSD ships skills (and commands/agents) as Markdown files under `commands/gsd/*.md`. Each runtime installs them via a per-runtime **layout** (where they go) and a per-runtime **converter** (how their content is rewritten). The layout is a typed `ArtifactKindDescriptor`:

```
{ kind, destSubpath, prefix, nesting, recursive, converter }
```

- **dest** — the destination subpath under the runtime's config dir (e.g. `skills`, `skills/gsd`).
- **prefix** — the filename/dir prefix (`gsd-` for every skill-bearing runtime).
- **nesting** — `flat` (skills at one level) or `nested` (concrete skills nested under `gsd-ns-*` router dirs).
- **loader** — whether the runtime's skill loader recurses (`recursive: true` → nesting saves nothing, so the layout stays flat).
- **converter** — the `ConverterName` (closed enum, ADR-1016) that rewrites the source command into the runtime's skill format. `null` means raw-copy (no conversion).

For the transform each converter applies, see [ADR-1593 §3 — converter transform-contract categories](../adr/1593-skill-mapping-converter-methodology.md#3-the-converter-transform-contract-categories).

## The 15-runtime matrix

| Runtime | Skill dest (global) | Prefix | Nesting | Loader | Converter | Notes |
|---------|---------------------|--------|---------|--------|-----------|-------|
| **claude** | `skills/` | `gsd-` | flat | one-level (reverted from nested, #924) | `convertClaudeCommandToClaudeSkill` | Local scope ships commands+agents only (no `skills` kind). Plugin manifest (ADR-766) ships skills via build-generated `skills/` dir (Phase B-provide, PR #1597, merged). |
| **codex** | `skills/` | `gsd-` | flat | unconfirmed → conservative | `convertClaudeCommandToCodexSkill` | TOML config (`configFormat: toml`). Description truncated to 180 chars (`metadata.short-description`). `sandboxTier: codex-agent-sandbox`. |
| **opencode** | `skills/` | `gsd-` | flat | recursive (`**` glob) | `convertClaudeCommandToOpencodeSkill` | XDG config home. Shares the opencode-family converter entry point (`convertClaudeCommandToOpencodeFamilySkill`). Also ships `command` (singular) commands. |
| **kilo** | `skills/` | `gsd-` | flat | recursive (`**` glob) | `convertClaudeCommandToKiloSkill` | OpenCode fork; same `**` glob loader. `permissionWriter: kilo`. Also ships `command` commands. |
| **cursor** | `skills/` | `gsd-` | flat | recursive | `convertClaudeCommandToCursorSkill` | Skills are the single slash-menu and contextual invocation surface; legacy managed `commands/` copies are retired by migration 008 (#2644). `configFormat: none`. |
| **copilot** | `skills/` | `gsd-` | flat | unconfirmed → conservative | `convertClaudeCommandToCopilotSkill` | Markdown config. Scope-aware converter (global-home vs workspace-relative). |
| **antigravity** | `skills/` | `gsd-` | flat | non-recursive (one-level) | `convertClaudeCommandToAntigravitySkill` | `dot-home-nested` config home. Scope-aware converter. Loader confirmed: *"will not recursive scan"*. Flattened by #1614 — `agy` scans only `skills/<name>/SKILL.md`, so nesting hid sub-skills. |
| **windsurf** | — *(no skills kind)* | `gsd-` | — | workflows | `convertClaudeCommandToWindsurfWorkflow` | Emits `.windsurf/workflows/gsd-*.md` slash-command workflows. `configFormat: none`. `installSurface: profile-marker-only`. |
| **augment** | `skills/` | `gsd-` | nested | non-recursive (single-level) | `convertClaudeCommandToAugmentSkill` | Also ships flat `commands/`. Settings-json config. |
| **trae** | `skills/` | `gsd-` | nested | non-recursive (flat; nesting errors) | `convertClaudeCommandToTraeSkill` | `configFormat: none`. Trae IDE (trae.ai), not trae-agent. |
| **qwen** | `skills/` | `gsd-` | nested | non-recursive (flat readdir) | `convertClaudeCommandToClaudeSkill` | **Shares Claude's converter.** Emits numeric `priority:` (`QWEN_SKILL_PRIORITY`) for `/skills` ordering. Settings-json config. |
| **hermes** | `skills/gsd/` | `gsd-` | nested | non-recursive (single-level probe) | `convertClaudeCommandToClaudeSkill` | **Shares Claude's converter.** `destSubpath: skills/gsd` (category dir). Emits required `version:` field. `prefix: gsd-` restored by #947. |
| **codebuddy** | `skills/` | `gsd-` | flat | unconfirmed → conservative | `convertClaudeCommandToCodebuddySkill` | Also ships flat `commands/` via `convertClaudeCommandToCodebuddyCommand`. `dot-home` config. |
| **cline** | `skills/` | `gsd-` | nested | non-recursive (flat `fs.readdir`) | `convertClaudeCommandToClineSkill` | **Global-only** — `local: []` (no local skill install). Targets `~/.cline/skills/<name>/SKILL.md` (Cline ≥ v3.48.0). `markdown-dir` config. |
| **kimi** | `skills/` | `gsd-` | flat | (false) | `convertClaudeCommandToKimiSkill` | Also ships a special `kimi-agents` kind (`buildKimiAgentArtifacts`). Name normalization (`normalizeKimiSkillName`). `generic-agents-root` config. |

### Structural facts

- **All 14 skill-bearing runtimes use `prefix: "gsd-"`.** One runtime has no skills kind: Windsurf (emits `.windsurf/workflows/gsd-*.md` slash-command workflows instead — #1615).
- **Five runtimes nest** (cline, qwen, hermes, augment, trae) because their skill loaders scan one level deep — nesting drops nested concrete skills out of the eager top-level listing while keeping them readable by file path (the namespace-router contract, #69).
- **Eight runtimes stay flat**: three because their loaders recurse (cursor, opencode, kilo — nesting saves nothing), two because nesting was reverted (claude — the Skill tool errors on unknown names rather than re-routing, #924; antigravity — `agy` scans only `skills/<name>/SKILL.md`, so nested sub-skills were unreachable, #1614), and three conservatively where the loader depth is unconfirmed (codex, copilot, codebuddy).
- **Three runtimes share `convertClaudeCommandToClaudeSkill`** (claude, qwen, hermes). The converter branches on the `runtime` arg for per-runtime branding (Hermes `version:`, Qwen `priority:`).

## Nesting/loader verification (June 2026)

The nesting flag is set per the verified loader behavior of each runtime. Sources:

| Behavior | Runtimes | Evidence |
|----------|----------|----------|
| **NEST** (non-recursive / one-level scan) | cline, qwen, hermes, augment, trae | cline `skills.ts` flat `fs.readdir`; Qwen `skill-load.ts` flat readdir; hermes single-level subdir probe; augment flat single-level; trae flat (nesting errors, Trae-AI/TRAE#2253) |
| **FLAT** (recursive loader → nesting gives no saving) | cursor, opencode, kilo | cursor walks skills root recursively; opencode `skill/index.ts` glob `skills/**/SKILL.md`; kilo (opencode fork, same `**` glob) |
| **FLAT** (reverted from nested) | claude, antigravity | claude: anthropics/claude-code#28266 — one-level scan, but Skill-tool errors on unknown names rather than re-routing via the router (#924). antigravity: `agy` scans only `skills/<name>/SKILL.md`; nesting made sub-skills unreachable, reverted to flat (#1614) |
| **FLAT** (unconfirmed → conservative) | codex, copilot, codebuddy | Loader depth not independently verified; kept flat to avoid mis-nesting |

## Plugin / external-skill provision + consumption

Per [ADR-1593 §5](../adr/1593-skill-mapping-converter-methodology.md#5-plugin--external-skill-provision--consumption-methodology), each platform's first-party packaging should provide and consume skills through the platform's *documented, native* mechanism.

| Runtime | Provision model | Consumption model | Outcome |
|---------|-----------------|-------------------|---------|
| **claude** | `.claude-plugin/plugin.json` `"skills": "./skills/"` — build-generated dir (PR #1597, merged) | Sub-agent `skills:` preload + runtime `Skill` tool (PR #1261, merged) | **Implemented (Phase B)** |
| **codex** | **N/A** — no plugin/extension manifest model. Uses `AGENTS.md` + TOML via file-copy install. | **N/A** — same rationale. | **C2: N/A** |
| **opencode / kilo** | **N/A** — no first-party plugin manifest. Recursive `skills/**/SKILL.md` glob loader scans the local config dir that `bin/install.js` writes to. | **N/A** — same rationale. | **C3: N/A** |
| **cursor, copilot, windsurf, codebuddy** | **N/A** — IDE-based tools with no plugin skill-provision model. File-copy install only. | **N/A** — same rationale. | **C4: N/A** |
| **cline, qwen, hermes, augment, trae, antigravity** | **N/A** — CLI tools with no plugin marketplace model. File-copy install only. | **N/A** — same rationale. | **C5: N/A** |
| **kimi** | **N/A** — special `kimi-agents` kind but no plugin/extension manifest. File-copy install only. | **N/A** — same rationale. | **C6: N/A** |

**Phase D (first-party packaging parity):** Complete. Claude Code's `.claude-plugin/plugin.json` is the only first-party manifest with a `skills` field (Phase B-provide, PR #1597). No other first-party packaging exists.

> **Rejected for all platforms:** reading another plugin's ephemeral/undocumented cache (e.g. Claude Code's `${CLAUDE_PLUGIN_ROOT}` / `~/.claude/plugins/cache`). The platform's native mechanism is the contract; cache-reading is a workaround, not a fix.

## Keeping this page in sync

The `capabilities/<runtime>/capability.json` `artifactLayout` descriptors are the source of truth. When a runtime's layout changes, update the descriptor first; this page is the projection. Adding a new runtime requires: (1) a new `capabilities/<runtime>/capability.json` with an `artifactLayout`, (2) a new converter in the closed `ConverterName` enum (ADR-1016), and (3) a new row in this matrix.

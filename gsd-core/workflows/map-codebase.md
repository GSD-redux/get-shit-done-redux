<purpose>
Orchestrate parallel codebase mapper agents to analyze codebase and produce structured documents in .planning/codebase/

Each agent has fresh context, explores a specific focus area, and **writes documents directly**. The orchestrator only receives confirmation + line counts, then writes a summary.

Output: .planning/codebase/ folder with 7 structured documents about the codebase state.
</purpose>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-codebase-mapper — Maps project structure and dependencies
</available_agent_types>

<philosophy>
**Why dedicated mapper agents:**
- Fresh context per domain (no token contamination)
- Agents write documents directly (no context transfer back to orchestrator)
- Orchestrator only summarizes what was created (minimal context usage)
- Faster execution (agents run simultaneously)

**Document quality over length:**
Include enough detail to be useful as reference. Prioritize practical examples (especially code patterns) over arbitrary brevity.

**Always include file paths:**
Documents are reference material for Claude when planning/executing. Always include actual file paths formatted with backticks: `src/services/user.ts`.
</philosophy>

<process>

<step name="parse_paths_flag" priority="first">
Parse an optional `--paths <p1,p2,...>` argument. When supplied (by the
post-execute codebase-drift gate in `/gsd:execute-phase` or by a user running
`/gsd:map-codebase --paths apps/accounting,packages/ui`), the workflow
operates in **incremental-remap mode**:

- Pass `--paths <p1>,<p2>,...` through to each spawned `gsd-codebase-mapper`
  agent's prompt. Agents scope their Glob/Grep/Bash exploration to the listed
  repo-relative prefixes only — no whole-repo scan.
- Reject path values that contain `..`, start with `/`, or include shell
  metacharacters (`;`, `` ` ``, `$`, `&`, `|`, `<`, `>`). If all provided
  paths are invalid, fall back to a normal whole-repo run.
- On write, each mapper stamps `last_mapped_commit: <HEAD sha>` into the YAML
  frontmatter of every document it produces (see `bin/lib/drift.cjs:writeMappedCommit`).

**Explicit contract — propagate `--paths` through a single normalized
variable.** Downstream steps (`spawn_agents`, `sequential_mapping`, and any
Agent-mode prompt construction) MUST use `${PATH_SCOPE_HINT}` to ensure every
mapper receives the same deterministic scope. Without this contract
incremental-remap can silently regress to a whole-repo scan.

```bash
# Validated, comma-separated paths (empty if --paths absent or all rejected):
SCOPED_PATHS="<validated paths or empty>"
if [ -n "$SCOPED_PATHS" ]; then
  PATH_SCOPE_HINT="--paths $SCOPED_PATHS"
else
  PATH_SCOPE_HINT=""
fi
```

All mapper prompts built later in this workflow MUST include
`${PATH_SCOPE_HINT}` (expanded to empty when full-repo mode is in effect).

When `--paths` is absent, behave exactly as before: full-repo scan, all 7
documents refreshed.
</step>

<step name="init_context" priority="first">
Load codebase mapping context:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(gsd_run query init.map-codebase)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_MAPPER=$(gsd_run query agent-skills gsd-codebase-mapper)
```

Extract from init JSON: `mapper_model`, `commit_docs`, `codebase_dir`, `existing_maps`, `has_maps`, `codebase_dir_exists`, `subagent_timeout`, `date`.
</step>

<step name="check_existing">
Check if .planning/codebase/ already exists using `has_maps` from init context.

If `codebase_dir_exists` is true:
```bash
ls -la .planning/codebase/
```

**If exists:**

```
.planning/codebase/ already exists with these documents:
[List files found]

What's next?
1. Refresh - Delete existing and remap codebase
2. Update - Keep existing, only update specific documents
3. Skip - Use existing codebase map as-is
```

Wait for user response.

If "Refresh": Delete .planning/codebase/, continue to create_structure
If "Update": Ask which documents to update, continue to spawn_agents (filtered)
If "Skip": Exit workflow

**If doesn't exist:**
Continue to create_structure.
</step>

<step name="create_structure">
Create .planning/codebase/ directory:

```bash
mkdir -p .planning/codebase
```

**Expected output files:**
- STACK.md (from tech mapper)
- INTEGRATIONS.md (from tech mapper)
- ARCHITECTURE.md (from arch mapper)
- STRUCTURE.md (from arch mapper)
- CONVENTIONS.md (from quality mapper)
- TESTING.md (from quality mapper)
- CONCERNS.md (from concerns mapper)

Continue to spawn_agents.
</step>

<step name="detect_runtime_capabilities">
Before spawning agents, detect whether the current runtime supports the `Agent` tool for subagent delegation.

**How to detect:** Check if you have access to an `Agent` tool (may be capitalized as `Agent` or lowercase as `agent` depending on runtime). If you do NOT have an `Agent`/`agent` tool (or only have tools like `browser_subagent` which is for web browsing, NOT code analysis):

→ **Skip `spawn_agents` and `collect_confirmations`** — go directly to `sequential_mapping` instead.

**CRITICAL:** Never use `browser_subagent` or `Explore` as a substitute for `Agent`. The `browser_subagent` tool is exclusively for web page interaction and will fail for codebase analysis. If `Agent` is unavailable, perform the mapping sequentially in-context.
</step>

<step name="spawn_agents" condition="Agent tool is available">
Spawn 4 parallel gsd-codebase-mapper agents.

<!-- #2508 runtime-aware-dispatch -->

> **Runtime-aware dispatch (#2508 Phase 4).** GSD workflows dispatch specialized subagents by role. Before dispatching on a built-in-only runtime (kimi-code — three built-ins only), resolve the role to a built-in via `gsd_run query resolve-dispatch-type --requested <role> --raw`. On named-dispatch runtimes (Claude/OpenCode/…) the role is returned unchanged; on kimi-code it maps to `coder`/`explore`/`plan` by role-suffix. The persona rides `${AGENT_SKILLS_<ROLE>}` (Phase 3) regardless. See @gsd-core/references/runtime-aware-dispatch.md.

<!-- #2517 model-omit-on-inherit -->

> **Model omission (#2517).** Omit the `model` parameter entirely when the value it would carry (`mapper_model`) is `"inherit"` or empty. An empty value 404s on runtimes without native tier aliases — the default on non-Claude runtimes. Omitting it inherits the orchestrator's model. See @gsd-core/references/model-profile-resolution.md.

Use Agent tool with `subagent_type="gsd-codebase-mapper"`, `model="{mapper_model}"`, and `run_in_background=true` for parallel execution.

**CRITICAL:** Use the dedicated `gsd-codebase-mapper` agent, NOT `Explore` or `browser_subagent`. The mapper agent writes documents directly.

Print: "Spawning 4 parallel codebase mapper agents (each runs in a subagent — no output until they return, ~1–5 min; expected, not a freeze)"

**Agent 1: Tech Focus**

```text
Agent(
  subagent_type="gsd-codebase-mapper",
  model="{mapper_model}",
  run_in_background=true,
  description="Map codebase tech stack",
  prompt="Focus: tech
Today's date: {date}

Analyze this codebase for technology stack and external integrations.

Write these documents to {codebase_dir}/:
- STACK.md - Languages, runtime, frameworks, dependencies, configuration
- INTEGRATIONS.md - External APIs, databases, auth providers, webhooks

IMPORTANT: Set all date stamps (`**Analysis Date:**`, footer `*... analysis: ...*`, `<!-- refreshed: ... -->`) to {date}, overwriting any existing date.

Scope: ${PATH_SCOPE_HINT:-(full repo)} — when --paths is supplied, restrict exploration to those prefixes only.

Explore thoroughly. Write documents directly using templates. Return confirmation only.
${AGENT_SKILLS_MAPPER}"
)
```

**Agent 2: Architecture Focus**

```text
Agent(
  subagent_type="gsd-codebase-mapper",
  model="{mapper_model}",
  run_in_background=true,
  description="Map codebase architecture",
  prompt="Focus: arch
Today's date: {date}

Analyze this codebase architecture and directory structure.

Write these documents to {codebase_dir}/:
- ARCHITECTURE.md - Pattern, layers, data flow, abstractions, entry points
- STRUCTURE.md - Directory layout, key locations, naming conventions

IMPORTANT: Set all date stamps (`**Analysis Date:**`, footer `*... analysis: ...*`, `<!-- refreshed: ... -->`) to {date}, overwriting any existing date.

Scope: ${PATH_SCOPE_HINT:-(full repo)} — when --paths is supplied, restrict exploration to those prefixes only.

Explore thoroughly. Write documents directly using templates. Return confirmation only.
${AGENT_SKILLS_MAPPER}"
)
```

**Agent 3: Quality Focus**

```text
Agent(
  subagent_type="gsd-codebase-mapper",
  model="{mapper_model}",
  run_in_background=true,
  description="Map codebase conventions",
  prompt="Focus: quality
Today's date: {date}

Analyze this codebase for coding conventions and testing patterns.

Write these documents to {codebase_dir}/:
- CONVENTIONS.md - Code style, naming, patterns, error handling
- TESTING.md - Framework, structure, mocking, coverage

IMPORTANT: Set all date stamps (`**Analysis Date:**`, footer `*... analysis: ...*`, `<!-- refreshed: ... -->`) to {date}, overwriting any existing date.

Scope: ${PATH_SCOPE_HINT:-(full repo)} — when --paths is supplied, restrict exploration to those prefixes only.

Explore thoroughly. Write documents directly using templates. Return confirmation only.
${AGENT_SKILLS_MAPPER}"
)
```

**Agent 4: Concerns Focus**

```
Agent(
  subagent_type="gsd-codebase-mapper",
  model="{mapper_model}",
  run_in_background=true,
  description="Map codebase concerns",
  prompt="Focus: concerns
Today's date: {date}

Analyze this codebase for technical debt, known issues, and areas of concern.

Write this document to {codebase_dir}/:
- CONCERNS.md - Tech debt, bugs, security, performance, fragile areas

IMPORTANT: Set all date stamps (`**Analysis Date:**`, footer `*... analysis: ...*`, `<!-- refreshed: ... -->`) to {date}, overwriting any existing date.

Scope: ${PATH_SCOPE_HINT:-(full repo)} — when --paths is supplied, restrict exploration to those prefixes only.

Explore thoroughly. Write document directly using template. Return confirmation only.
${AGENT_SKILLS_MAPPER}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling all 4 Agent() calls above with `run_in_background=true`, do NOT read any source files, analyze the codebase, or write any mapping documents independently while the subagents are active. Wait for all 4 agents to complete before proceeding to collect_confirmations. This prevents duplicate work and wasted context.

Continue to collect_confirmations.
</step>

<step name="collect_confirmations">
Wait for all 4 background agents to finish, then read each agent's output file to collect confirmations.

Each `Agent(...)` call above with `run_in_background=true` returns an `async_launched` result that carries an `outputFile` path (and `canReadOutputFile: true`). The 4 agents run concurrently and each one's completion arrives as a message in this conversation when it finishes — do NOT issue a separate blocking call to wait for them.

**Once all 4 agents have reported completion, read each agent's output file (single message with 4 Read calls):**
```
Read tool:
  file_path: "{outputFile from that agent's async_launched result}"
```

> Allow up to `workflow.subagent_timeout` for the slowest agent to finish before treating it as failed. The timeout is configurable via `workflow.subagent_timeout` in `.planning/config.json` (milliseconds). Default: 300000 (5 minutes). Increase for large codebases or slower models.

Each output file contains that agent's completion confirmation. Parse the confirmation marker (see below) from the file contents.

**Expected confirmation format from each agent:**
```
## Mapping Complete

**Focus:** {focus}
**Documents written:**
- `.planning/codebase/{DOC1}.md` ({N} lines)
- `.planning/codebase/{DOC2}.md` ({N} lines)

Ready for orchestrator summary.
```

**What you receive:** Just file paths and line counts. NOT document contents.

If any agent failed, note the failure and continue with successful documents.

Continue to verify_output.
</step>

<step name="sequential_mapping" condition="Agent tool is NOT available (e.g. Antigravity, Gemini CLI, Codex)">
When the `Agent` tool is unavailable, perform codebase mapping sequentially in the current context. This replaces `spawn_agents` and `collect_confirmations`.

**IMPORTANT:** Do NOT use `browser_subagent`, `Explore`, or any browser-based tool. Use only file system tools (Read, Bash, Write, Grep, Glob, list_dir, view_file, grep_search, or equivalent tools available in your runtime).

**IMPORTANT:** Set all date stamps (`**Analysis Date:**`, footer, `<!-- refreshed -->`) to `{date}` from init context, overwriting any existing date — Update runs seed from files with concrete prior dates, so merely replacing `[YYYY-MM-DD]` placeholders is not sufficient. NEVER guess the date.

**SCOPE:** When `${PATH_SCOPE_HINT}` is non-empty (i.e. `--paths` was supplied), restrict every pass below to the validated path prefixes in `${SCOPED_PATHS}`. Do NOT scan files outside those prefixes. When `${PATH_SCOPE_HINT}` is empty, perform a full-repo scan.

Perform all 4 mapping passes sequentially:

**Pass 1: Tech Focus**
- Explore package.json/Cargo.toml/go.mod/requirements.txt, config files, dependency trees
- Write `.planning/codebase/STACK.md` — Languages, runtime, frameworks, dependencies, configuration
- Write `.planning/codebase/INTEGRATIONS.md` — External APIs, databases, auth providers, webhooks

**Pass 2: Architecture Focus**
- Explore directory structure, entry points, module boundaries, data flow
- Write `.planning/codebase/ARCHITECTURE.md` — Pattern, layers, data flow, abstractions, entry points
- Write `.planning/codebase/STRUCTURE.md` — Directory layout, key locations, naming conventions

**Pass 3: Quality Focus**
- Explore code style, error handling patterns, test files, CI config
- Write `.planning/codebase/CONVENTIONS.md` — Code style, naming, patterns, error handling
- Write `.planning/codebase/TESTING.md` — Framework, structure, mocking, coverage

**Pass 4: Concerns Focus**
- Explore TODOs, known issues, fragile areas, security patterns
- Write `.planning/codebase/CONCERNS.md` — Tech debt, bugs, security, performance, fragile areas

Use the same document templates as the `gsd-codebase-mapper` agent. Include actual file paths formatted with backticks.

Continue to verify_output.
</step>

<step name="verify_output">
Verify all documents created successfully:

```bash
ls -la .planning/codebase/
wc -l .planning/codebase/*.md
```

**Verification checklist:**
- All 7 documents exist
- No empty documents (each should have >20 lines)

If any documents missing or empty, note which agents may have failed.

Continue to scan_for_secrets.
</step>

<step name="scan_for_secrets">
**CRITICAL SECURITY CHECK:** Scan output files for accidentally leaked secrets before committing.

Run secret pattern detection:

```bash
# Check for common API key patterns in generated docs
grep -E '(sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]+|sk_test_[a-zA-Z0-9]+|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]+|AKIA[A-Z0-9]{16}|xox[baprs]-[a-zA-Z0-9-]+|-----BEGIN.*PRIVATE KEY|eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.)' .planning/codebase/*.md 2>/dev/null && SECRETS_FOUND=true || SECRETS_FOUND=false
```

**If SECRETS_FOUND=true:**

```
⚠️  SECURITY ALERT: Potential secrets detected in codebase documents!

Found patterns that look like API keys or tokens in:
[show grep output]

This would expose credentials if committed.

**Action required:**
1. Review the flagged content above
2. If these are real secrets, they must be removed before committing
3. Consider adding sensitive files to Claude Code "Deny" permissions

Pausing before commit. Reply "safe to proceed" if the flagged content is not actually sensitive, or edit the files first.
```

Wait for user confirmation before continuing to commit_codebase_map.

**If SECRETS_FOUND=false:**

Continue to commit_codebase_map.
</step>

<step name="commit_codebase_map">
Commit the codebase map:

```bash
gsd_run query commit "docs: map existing codebase" --files .planning/codebase/*.md
```

Continue to offer_next.
</step>

<step name="offer_next">
Present completion summary and next steps.

**Get line counts:**
```bash
wc -l .planning/codebase/*.md
```

**Output format:**

```
Codebase mapping complete.

Created .planning/codebase/:
- STACK.md ([N] lines) - Technologies and dependencies
- ARCHITECTURE.md ([N] lines) - System design and patterns
- STRUCTURE.md ([N] lines) - Directory layout and organization
- CONVENTIONS.md ([N] lines) - Code style and patterns
- TESTING.md ([N] lines) - Test structure and practices
- INTEGRATIONS.md ([N] lines) - External services and APIs
- CONCERNS.md ([N] lines) - Technical debt and issues

---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Initialize project** — use codebase context for planning

`/clear` then:

`/gsd:new-project`

---

**Also available:**
- Re-run mapping: `/gsd:map-codebase`
- Review specific file: `cat .planning/codebase/STACK.md`
- Edit any document before proceeding

---
```

End workflow.
</step>

</process>

<success_criteria>
- .planning/codebase/ directory created
- If Agent tool available: 4 parallel gsd-codebase-mapper agents spawned with run_in_background=true
- If Agent tool NOT available: 4 sequential mapping passes performed inline (never using browser_subagent)
- All 7 codebase documents exist
- No empty documents (each should have >20 lines)
- Clear completion summary with line counts
- User offered clear next steps in GSD style
</success_criteria>

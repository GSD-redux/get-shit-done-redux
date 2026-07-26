<purpose>
Analyze freeform text from the user and route to the most appropriate GSD command. This is a dispatcher — it never does the work itself. Match user intent to the best command, confirm the routing, and hand off.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=0; if [ -f "$GSD_TOOLS" ]; then _GSD_FOUND=1; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${QODER_CONFIG_DIR:-$HOME/.qoder}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QODER_CONFIG_DIR:-$HOME/.qoder}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; [ "$_GSD_FOUND" = "1" ] && gsd_run() { node "$GSD_TOOLS" "$@"; }; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --default "" 2>/dev/null || echo "")
```

**If `response_language` is set:** All user-facing questions, prompts, and explanations in this workflow MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

<step name="validate">
**Check for input.**


**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
If `$ARGUMENTS` is empty, ask via AskUserQuestion:

```
What would you like to do? Describe the task, bug, or idea and I'll route it to the right GSD command.
```

Wait for response before continuing.
</step>

<step name="check_project">
**Check if project exists.**

```bash
INIT=$(gsd_run query state.load 2>/dev/null)
```

Track whether `.planning/` exists — some routes require it, others don't.
</step>

<step name="route">
**Match intent to command.**

Evaluate `$ARGUMENTS` against these routing rules. Apply the **first matching** rule:

| If the text describes... | Route to | Why |
|--------------------------|----------|-----|
| Starting a new greenfield project, "set up", "initialize" | `/gsd:new-project` | Needs full project initialization |
| First-time setup for an existing codebase, brownfield onboarding | `/gsd:onboard` | Safe map → docs ingest → project setup sequence |
| Mapping or analyzing an existing codebase map | `/gsd:map-codebase` | Codebase discovery or refresh |
| A bug, error, crash, failure, or something broken | `/gsd:debug` | Needs systematic investigation |
| Spiking, "test if", "will this work", "experiment", "prove this out", validate feasibility | `/gsd:spike` | Throwaway experiment to validate feasibility |
| Sketching, "mockup", "what would this look like", "prototype the UI", "design this", explore visual direction | `/gsd:sketch` | Throwaway HTML mockups to explore design |
| Wrapping up spikes, "package the spikes", "consolidate spike findings" | `/gsd:spike --wrap-up` | Package spike findings into reusable skill |
| Wrapping up sketches, "package the designs", "consolidate sketch findings" | `/gsd:sketch --wrap-up` | Package sketch findings into reusable skill |
| Exploring, researching, comparing, or "how does X work" | `/gsd:explore` | Socratic ideation and idea routing |
| Discussing vision, "how should X look", brainstorming | `/gsd:discuss-phase` | Needs context gathering |
| A complex task: refactoring, migration, multi-file architecture, system redesign | `/gsd:phase` | Needs a full phase with plan/build cycle |
| Planning a specific phase or "plan phase N" | `/gsd:plan-phase` | Direct planning request |
| Executing a phase or "build phase N", "run phase N" | `/gsd:execute-phase` | Direct execution request |
| Running all remaining phases automatically | `/gsd:autonomous` | Full autonomous execution |
| A review or quality concern about existing work | `/gsd:verify-work` | Needs verification |
| Checking progress, status, "where am I" | `/gsd:progress` | Status check |
| Resuming work, "pick up where I left off" | `/gsd:resume-work` | Session restoration |
| A note, idea, or "remember to..." | `/gsd:capture` | Capture for later |
| Adding tests, "write tests", "test coverage" | `/gsd:add-tests` | Test generation |
| Completing a milestone, shipping, releasing | `/gsd:complete-milestone` | Milestone lifecycle |
| A specific, actionable, small task (add feature, fix typo, update config) | `/gsd:quick` | Self-contained, single executor |

**Requires `.planning/` directory:** All routes except `/gsd:new-project`, `/gsd:onboard`, `/gsd:map-codebase`, `/gsd:spike`, `/gsd:sketch`, and `/gsd:help`. If the project doesn't exist and the route requires it, suggest `/gsd:onboard` for existing codebases or `/gsd:new-project` for greenfield projects.

**Ambiguity handling:** If the text could reasonably match multiple routes, ask the user via AskUserQuestion with the top 2-3 options. For example:

```
"Refactor the authentication system" could be:
1. /gsd:phase — Full planning cycle (recommended for multi-file refactors)
2. /gsd:quick — Quick execution (if scope is small and clear)

Which approach fits better?
```
</step>

<step name="display">
**Show the routing decision.**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► ROUTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Input:** {first 80 chars of $ARGUMENTS}
**Routing to:** {chosen command}
**Reason:** {one-line explanation}
```
</step>

<step name="dispatch">
**Invoke the chosen command.**

Run the selected `/gsd-*` command, passing `$ARGUMENTS` as args.

If the chosen command expects a phase number and one wasn't provided in the text, extract it from context or ask via AskUserQuestion.

After invoking the command, stop. The dispatched command handles everything from here.
</step>

</process>

<success_criteria>
- [ ] Input validated (not empty)
- [ ] Intent matched to exactly one GSD command
- [ ] Ambiguity resolved via user question (if needed)
- [ ] Project existence checked for routes that require it
- [ ] Routing decision displayed before dispatch
- [ ] Command invoked with appropriate arguments
- [ ] No work done directly — dispatcher only
</success_criteria>

<purpose>
Analyze freeform text from the user and route to the most appropriate GSD command. This is a dispatcher — it never does the work itself. Match user intent to the best command, confirm the routing, and hand off.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

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

Evaluate `$ARGUMENTS` against these routing rules. Rules are ordered **most-specific first**: apply the **first matching** rule, and never let a generic keyword rule ("set up", "spike", "review") preempt a more specific operation that also matches ("set up this existing codebase", "wrap up the spike findings", "review the changed source code").

| If the text describes... | Route to | Why |
|--------------------------|----------|-----|
| First-time setup for an existing codebase, brownfield onboarding, "onboard this codebase" | `/gsd:onboard` | Safe map → docs ingest → project setup sequence |
| Starting a new greenfield project, "set up", "initialize" (no existing codebase named) | `/gsd:new-project` | Needs full project initialization |
| Mapping or analyzing an existing codebase map | `/gsd:map-codebase` | Codebase discovery or refresh |
| A bug, error, crash, failure, or something broken | `/gsd:debug` | Needs systematic investigation |
| Wrapping up spikes, "package the spikes", "consolidate spike findings" | `/gsd:spike --wrap-up` | Package spike findings into reusable skill |
| Wrapping up sketches, "package the designs", "consolidate sketch findings" | `/gsd:sketch --wrap-up` | Package sketch findings into reusable skill |
| Spiking, "test if", "will this work", "experiment", "prove this out", validate feasibility | `/gsd:spike` | Throwaway experiment to validate feasibility |
| Sketching, "mockup", "what would this look like", "prototype the UI", "design this", explore visual direction | `/gsd:sketch` | Throwaway HTML mockups to explore design |
| Reviewing changed source code for bugs, security issues, or code quality ("code review the changes") | `/gsd:code-review` | Source review of phase-changed files |
| Requesting peer review of phase plans from another AI CLI ("plan review", "review the plan") | `/gsd:review` | Cross-AI plan review |
| Reviewing or hardening implemented UI ("visual audit", "review the UI") | `/gsd:ui-review` | Retroactive 6-pillar visual audit |
| Verifying security mitigations of a completed phase ("security check", "secure phase N") | `/gsd:secure-phase` | Retroactive threat-mitigation verification |
| Auditing milestone completion against original intent ("audit the milestone") | `/gsd:audit-milestone` | Milestone audit against original intent |
| An autonomous audit-to-fix pass ("audit and fix", "audit the repo and fix what it finds") | `/gsd:audit-fix` | Audit-to-fix pipeline |
| Generating or updating project documentation ("update the docs", "documentation update") | `/gsd:docs-update` | Docs verified against the codebase |
| Exploring, researching, comparing, or "how does X work" | `/gsd:explore` | Socratic ideation and idea routing |
| Discussing vision, "how should X look", brainstorming | `/gsd:discuss-phase` | Needs context gathering |
| Planning a specific phase or "plan phase N" | `/gsd:plan-phase` | Direct planning request |
| Executing a phase or "build phase N", "run phase N" (SDD dependency-aware wave execution) | `/gsd:execute-phase` | Direct execution request |
| Adding, inserting, removing, or editing phases in the roadmap ("multi-phase", roadmap phase management) | `/gsd:phase` | Roadmap phase CRUD |
| A complex task: refactoring, migration, multi-file architecture, system redesign | `/gsd:plan-phase` | Needs a full phase with plan/build cycle |
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
1. /gsd:plan-phase — Full planning cycle (recommended for multi-file refactors)
2. /gsd:quick — Quick execution (if scope is small and clear)

Which approach fits better?
```
</step>

<step name="display">
**Show the routing decision.**

```
### GSD ► ROUTING

**Input:** {first 80 chars of $ARGUMENTS}
**Routing to:** {chosen command}
**Reason:** {one-line explanation}
```
</step>

<step name="confirm">
**Confirm the route before dispatching (REQ-DO-03).**

Before invoking anything, ask the user to confirm the displayed route via AskUserQuestion:

```
Route to {chosen command}?
1. Yes — proceed with {chosen command} (recommended)
2. Choose a different command
3. Cancel — do not dispatch
```

- **Yes / proceed:** continue to the dispatch step.
- **Choose a different command:** present the 2-3 next-best routes from the routing table as options and loop back through display + confirm with the new selection.
- **Cancel:** stop. Do not invoke any command.

**TEXT_MODE:** present the same choices as a plain-text numbered list and ask the user to type their choice number, exactly like other AskUserQuestion calls in this workflow.
</step>

<step name="dispatch">
**Invoke the chosen command with only the arguments it accepts.**

Read the chosen command's frontmatter `argument-hint` (in `commands/gsd/<name>.md`) and forward **only arguments that command accepts**. Do NOT pass the full freeform sentence wholesale.

- If the command expects a phase number or flags only (e.g. `/gsd:verify-work [phase number]`, `/gsd:plan-phase`, `/gsd:execute-phase`), extract the phase number / flags from the input; if none was provided, extract it from context or ask via AskUserQuestion. Drop the surrounding prose.
- If the command explicitly accepts a freeform task description (e.g. `/gsd:quick`, `/gsd:debug`, `/gsd:spike`, `/gsd:sketch`), forward the relevant portion of `$ARGUMENTS` as the description.
- If the command takes no arguments, invoke it without arguments.

After invoking the command, stop. The dispatched command handles everything from here.
</step>

</process>

<success_criteria>
- [ ] Input validated (not empty)
- [ ] Intent matched to exactly one GSD command
- [ ] Ambiguity resolved via user question (if needed)
- [ ] Project existence checked for routes that require it
- [ ] Routing decision displayed before dispatch
- [ ] Route confirmed by the user before dispatch (REQ-DO-03), with TEXT_MODE equivalent
- [ ] Command invoked with only the arguments it accepts (argument-hint aware; freeform text only where the command takes a freeform description)
- [ ] No work done directly — dispatcher only
</success_criteria>

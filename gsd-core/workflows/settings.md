<purpose>
Interactive configuration of GSD workflow agents (research, plan_check, verifier) and model profile selection via multi-question prompt. Updates .planning/config.json with user preferences. Optionally saves settings as global defaults (~/.gsd/defaults.json) for future projects.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="ensure_and_load_config">
Ensure config exists and load current state:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --default "" 2>/dev/null || echo "")
gsd_run query config-ensure-section
INIT=$(gsd_run query state.load)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
# `state.load` returns STATE frontmatter JSON from the SDK — it does not include `config_path`. Orchestrators may set `GSD_CONFIG_PATH` from init phase-op JSON; otherwise resolve the same path gsd-tools uses for flat vs active workstream (#2282).
if [[ -z "${GSD_CONFIG_PATH:-}" ]]; then
  if [[ -f .planning/active-workstream ]]; then
    WS=$(tr -d '\n\r' < .planning/active-workstream)
    GSD_CONFIG_PATH=".planning/workstreams/${WS}/config.json"
  else
    GSD_CONFIG_PATH=".planning/config.json"
  fi
fi
```

**If `response_language` is set:** All user-facing questions, prompts, and explanations in this workflow MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

Creates `config.json` (at the resolved path) with defaults if missing. `INIT` still holds `state.load` output for any step that needs STATE fields.
Store `$GSD_CONFIG_PATH` — all subsequent reads and writes use this path, not a hardcoded `.planning/config.json`, so active-workstream installs target the correct file (#2282).
</step>

<step name="read_current">
```bash
cat "$GSD_CONFIG_PATH"
```

Parse current values (default to `true` if not present):
- `workflow.research` — spawn researcher during plan-phase
- `workflow.plan_check` — spawn plan checker during plan-phase
- `workflow.verifier` — spawn verifier during execute-phase
- `plan_review.source_grounding` — verify plan symbols against live source during plan review (default: true if absent; set `plan_review.source_grounding_authority` to select the resolver adapter: `grep` (default), `intel`, `treesitter`, `lsp`, or `scip`)
- `workflow.nyquist_validation` — validation architecture research during plan-phase (default: true if absent)
- `workflow.pattern_mapper` — run gsd-pattern-mapper between research and planning (default: true if absent)
- `workflow.ui_phase` — generate UI-SPEC.md design contracts for frontend phases (default: true if absent)
- `workflow.ui_safety_gate` — prompt to run /gsd:ui-phase before planning frontend phases (default: true if absent)
- `workflow.ai_integration_phase` — framework selection + eval strategy for AI phases (default: true if absent)
- `workflow.tdd_mode` — enforce RED/GREEN/REFACTOR gate sequence during execute-phase (default: false if absent)
- `workflow.code_review` — enable /gsd:code-review and /gsd:code-review --fix commands (default: true if absent)
- `workflow.code_review_depth` — default depth for /gsd:code-review: `quick`, `standard`, or `deep` (default: `"standard"` if absent; only relevant when `code_review` is on)
- `workflow.ui_review` — run visual quality audit (/gsd:ui-review) in autonomous mode (default: true if absent)
- `commit_docs` — whether `.planning/` files are committed to git (default: true if absent)
- `intel.enabled` — enable queryable codebase intelligence (/gsd:map-codebase --query) (default: false if absent)
- `graphify.enabled` — enable project knowledge graph (/gsd:graphify) (default: false if absent)
- `graphify.auto_update` — opt-in: auto-rebuild graph after main HEAD advances (#3347) (default: `false`)
- `model_profile` — which model each agent uses (default: `balanced`)
- `git.branching_strategy` — branching approach (default: `"none"`)
- `workflow.use_worktrees` — whether parallel executor agents run in worktree isolation (default: `true` on Claude Code; non-Claude installs default it to `false` and fail closed on an explicit `true` — #1521, #2486)
- `model_policy.provider` — provider slug for model policy (default: `null`; known values: anthropic, openai, google, qwen; set via /gsd:config --advanced)
- `model_policy.budget` — budget level for model policy (default: `null`; known values: high, medium, low; set via /gsd:config --advanced)
- `model_policy.high` — model ID for high-cost tier (default: `null`; set via /gsd:config --advanced)
- `model_policy.medium` — model ID for medium-cost tier (default: `null`; set via /gsd:config --advanced)
- `model_policy.low` — model ID for low-cost tier (default: `null`; set via /gsd:config --advanced)
</step>

<step name="present_settings">

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.

**Non-Claude runtime note:** If `TEXT_MODE` is active (i.e. the runtime is non-Claude), prepend the following notice before the model profile question:

```
Note: Quality, Balanced, Budget, and Adaptive profiles assign semantic tiers
(Opus/Sonnet/Haiku) to each agent. When `runtime` is set in .planning/config.json,
tiers resolve to runtime-native model IDs — on Codex that's gpt-5.6-sol / gpt-5.6-terra /
gpt-5.6-luna with appropriate reasoning effort. See "Runtime-Aware Profiles" in
docs/CONFIGURATION.md.

If `runtime` is unset on a non-Claude runtime, the profile tiers have no effect on
actual model selection — agents use the runtime's default model. Choose "Inherit" to
force session-model behavior, set `runtime` + a profile to get tiered models, or
configure `model_overrides` manually in .planning/config.json to target specific
models per agent.
```

**Runtime resolution for the Worktrees question (#2486):** resolve the runtime and the current worktrees value with the same reads the execution workflows use, before presenting the questions:

```bash
RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")
USE_WORKTREES_CURRENT=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")
```

Use AskUserQuestion with current values pre-selected. Questions are grouped into six visual sections; the first question in each section carries the section-denoting `header` field (AskUserQuestion renders abbreviated section tags for grouping, max 12 chars).

Section layout:

### Planning
Research, Plan Checker, Drift Guard, Pattern Mapper, Nyquist, UI Phase, UI Gate, AI Phase

### Execution
Verifier, TDD Mode, Code Review, Code Review Depth _(conditional — only when code_review=on)_, UI Review

### Docs & Output
Commit Docs, Skip Discuss, Worktrees

### Features
Intel, Graphify, Graph auto-update _(conditional — only when graphify=on)_

### Model & Pipeline
Model Profile, Auto-Advance, Branching

### Misc
Context Warnings, Research Qs

**Conditional visibility — code_review_depth:** This question is shown only when the user's chosen `code_review` value (after they answer that question, or the pre-selected value if unchanged) is on. If `code_review` is off, omit the `code_review_depth` question from the AskUserQuestion block and preserve the existing `workflow.code_review_depth` value in config (do not overwrite). Implementation: ask the Model + Planning + Execution-up-to-Code-Review questions first; if `code_review=on`, include `code_review_depth` in the same batch; otherwise skip it. Conceptually this is a one-branch split on the `code_review` answer.

**Conditional visibility — graphify.auto_update:** This question is shown only when the user's chosen `graphify.enabled` value is on. If `graphify.enabled` is off, omit the `graphify.auto_update` question and preserve the existing `graphify.auto_update` value in config (do not overwrite). Implementation: ask Graphify first; only ask Graph auto-update when Graphify is enabled.

**Conditional options — Worktrees (#2486):** GSD's worktree isolation uses Claude Code's `isolation="worktree"` agent primitive, which no other runtime honors — the execution workflows fail closed on an explicit `workflow.use_worktrees: true` when `RUNTIME != claude`. This question deliberately branches on the same `config-get runtime` read those guards use (an explicit `runtime` key in config overrides the emitted default in both places), so this flow and the execution guards always reach the same verdict — never persist a value the guards would fail closed on, never withhold one they accept. Branch the Worktrees question on `$RUNTIME`:

- **If `RUNTIME` = `claude`:** present the Worktrees question exactly as written in the block below (unchanged behavior).
- **If `RUNTIME` ≠ `claude`:** replace the Worktrees question's options with the two below — do NOT offer an enabling option, and NEVER write `workflow.use_worktrees: true` from this workflow on a non-Claude runtime, regardless of the user's answer:

```
{
  question: "Use git worktrees for parallel agent isolation?",
  header: "Worktrees",
  multiSelect: false,
  options: [
    { label: "No (Recommended)", description: "Write use_worktrees: false. Worktree isolation requires Claude Code's isolation=\"worktree\" agent primitive — this runtime cannot honor it, and execution fails closed on an explicit true." },
    { label: "Leave unchanged", description: "Do not write the key. Absent, it already resolves to false on this runtime; an existing explicit value is kept intact (e.g. for a Claude Code install sharing this config)." }
  ]
}
```

  Persistence: "No (Recommended)" → write `workflow.use_worktrees: false`; "Leave unchanged" → do not write `workflow.use_worktrees` at all (preserve the existing value or absence).

  Pre-selection: the generic "current values pre-selected" rule does not apply to this question on a non-Claude runtime (an explicit `true` has no matching option by design). Pre-select "No (Recommended)" when `$USE_WORKTREES_CURRENT` is `false`; otherwise (key absent, or an explicit non-false value) pre-select "Leave unchanged". In TEXT_MODE, mark that option as the default choice in the numbered list.

  Additionally, if `$USE_WORKTREES_CURRENT` is not `false` (the config carries an explicit `true` this runtime fails closed on — e.g. inherited from a Claude Code install sharing the repo), prepend this notice before the question:

```
Note: .planning/config.json currently sets workflow.use_worktrees: true. This
runtime cannot honor worktree isolation (a Claude Code-only agent primitive), so
/gsd:execute-phase and /gsd:quick fail closed on this value. Choose "No" to
repair it for this runtime, or "Leave unchanged" to keep it for a Claude Code
install that shares this config (this runtime's commands will keep failing until
it is set to false here).
```

```
// Model profile is selected via a two-question split because AskUserQuestion enforces a
// hard 4-option cap and there are 5 valid profiles (quality, balanced, budget, adaptive,
// inherit). Q1 routes between adaptive/standard-tier/inherit; Q2 (shown only when the
// user chose "Standard tier" in Q1) picks among the three standard profiles. (#3784)
AskUserQuestion([
  {
    question: "Which model profile for agents?",
    header: "Model",
    multiSelect: false,
    options: [
      { label: "Adaptive (Recommended)", description: "Role-based cost optimization: heavy roles use the highest-tier model available on the active runtime, light roles use the cheapest. Best balance of quality and cost across all supported runtimes (Claude, Codex, Gemini, OpenRouter, local)." },
      { label: "Standard tier…", description: "Choose Quality, Balanced, or Budget — flat tier applied to all agents" },
      { label: "Inherit", description: "Use current session model for all agents (required for non-Claude runtimes: Codex, Gemini CLI, OpenRouter, local models)" }
    ]
  }
])

**Conditional visibility — model_profile (Q2):**
  Only ask this question when Q1's answer is "Standard tier…".
  If Q1 = "Adaptive (Recommended)" → write model_profile=adaptive and SKIP Q2.
  If Q1 = "Inherit"                → write model_profile=inherit and SKIP Q2.
  If user cancels Q2 after picking "Standard tier…" → leave existing model_profile value unchanged (mirror code_review_depth's cancellation rule).

AskUserQuestion([
  {
    question: "Which standard profile? (Quality / Balanced / Budget)",
    header: "Model Tier",
    multiSelect: false,
    options: [
      { label: "Quality", description: "Opus everywhere except verification (highest cost) — Claude only" },
      { label: "Balanced", description: "Opus for planning, Sonnet for research/execution/verification — Claude only" },
      { label: "Budget", description: "Sonnet for writing, Haiku for research/verification (lowest cost) — Claude only" }
    ]
  }
])

// Map UI choices → config values:
//   Q1 "Adaptive (Recommended)" → model_profile = "adaptive"
//   Q1 "Inherit"                → model_profile = "inherit"
//   Q1 "Standard tier…" + Q2 "Quality"   → model_profile = "quality"
//   Q1 "Standard tier…" + Q2 "Balanced"  → model_profile = "balanced"
//   Q1 "Standard tier…" + Q2 "Budget"    → model_profile = "budget"

AskUserQuestion([
  {
    question: "Spawn Plan Researcher? (researches domain before planning)",
    header: "Research",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Research phase goals before planning" },
      { label: "No", description: "Skip research, plan directly" }
    ]
  },
  {
    question: "Spawn Plan Checker? (verifies plans before execution)",
    header: "Plan Check",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Verify plans meet phase goals" },
      { label: "No", description: "Skip plan verification" }
    ]
  },
  {
    question: "Spawn Execution Verifier? (verifies phase completion)",
    header: "Verifier",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Verify must-haves after execution" },
      { label: "No", description: "Skip post-execution verification" }
    ]
  },
  {
    question: "Enable Plan Drift Guard? (verifies that symbols cited in plans exist in source at review time)",
    header: "Drift Guard",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Resolve symbol references (decorators, classes, functions, CLI flags) against live source — catches hallucinated names before execution. Authority controlled by plan_review.source_grounding_authority (default: grep)." },
      { label: "No", description: "Skip symbol grounding. Plan review proceeds without source verification." }
    ]
  },
  {
    question: "Enable TDD Mode? (RED/GREEN/REFACTOR gates for eligible tasks)",
    header: "TDD",
    multiSelect: false,
    options: [
      { label: "No (Recommended)", description: "Execute tasks normally. Tests written alongside implementation." },
      { label: "Yes", description: "Planner applies type:tdd to business logic/APIs/validations; executor enforces gate sequence. End-of-phase review checks compliance." }
    ]
  },
  {
    question: "Enable Code Review? (/gsd:code-review and /gsd:code-review --fix commands)",
    header: "Code Review",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Enable /gsd:code-review commands for reviewing source files changed during a phase." },
      { label: "No", description: "Commands exit with a configuration gate message. Use when code review is handled externally." }
    ]
  },
  // Conditional: include the following code_review_depth question ONLY when the user's
  // chosen code_review value is "Yes". If code_review is "No", omit this question from
  // the AskUserQuestion call and do not touch the existing workflow.code_review_depth value.
  {
    question: "Code Review Depth? (default depth for /gsd:code-review — override per-run with --depth=)",
    header: "Review Depth",
    multiSelect: false,
    options: [
      { label: "Standard (Recommended)", description: "Per-file analysis. Balanced cost and signal." },
      { label: "Quick", description: "Pattern-matching only. Fastest, lowest cost." },
      { label: "Deep", description: "Cross-file analysis with import graphs. Highest cost, highest signal." }
    ]
  },
  {
    question: "Enable UI Review? (visual quality audit via /gsd:ui-review in autonomous mode)",
    header: "UI Review",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Run visual quality audit after phase execution in autonomous mode." },
      { label: "No", description: "Skip the UI audit step. Good for backend-only projects." }
    ]
  },
  {
    question: "Auto-advance pipeline? (discuss → plan → execute automatically)",
    header: "Auto",
    multiSelect: false,
    options: [
      { label: "No (Recommended)", description: "Manual /clear + paste between stages" },
      { label: "Yes", description: "Chain stages via Agent() subagents (same isolation)" }
    ]
  },
  {
    question: "Run Pattern Mapper? (maps new files to existing codebase analogs between research and planning)",
    header: "Pattern Mapper",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "gsd-pattern-mapper runs between research and plan steps. Surfaces conventions so new code follows house style." },
      { label: "No", description: "Skip pattern mapping. Faster; lose consistency hinting for new files." }
    ]
  },
  {
    question: "Enable Nyquist Validation? (researches test coverage during planning)",
    header: "Nyquist",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Research automated test coverage during plan-phase. Adds validation requirements to plans. Blocks approval if tasks lack automated verify." },
      { label: "No", description: "Skip validation research. Good for rapid prototyping or no-test phases." }
    ]
  },
  // Note: Nyquist validation depends on research output. If research is disabled,
  // plan-phase automatically skips Nyquist steps (no RESEARCH.md to extract from).
  {
    question: "Enable UI Phase? (generates UI-SPEC.md design contracts for frontend phases)",
    header: "UI Phase",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Generate UI design contracts before planning frontend phases. Locks spacing, typography, color, and copywriting." },
      { label: "No", description: "Skip UI-SPEC generation. Good for backend-only projects or API phases." }
    ]
  },
  {
    question: "Enable UI Safety Gate? (prompts to run /gsd:ui-phase before planning frontend phases)",
    header: "UI Gate",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "plan-phase asks to run /gsd:ui-phase first when frontend indicators detected." },
      { label: "No", description: "No prompt — plan-phase proceeds without UI-SPEC check." }
    ]
  },
  {
    question: "Enable AI Phase? (framework selection + eval strategy for AI phases)",
    header: "AI Phase",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Run /gsd:ai-integration-phase before planning AI system phases. Surfaces the right framework, researches its docs, and designs the evaluation strategy." },
      { label: "No", description: "Skip AI design contract. Good for non-AI phases or when framework is already decided." }
    ]
  },
  {
    question: "Git branching strategy?",
    header: "Branching",
    multiSelect: false,
    options: [
      { label: "None (Recommended)", description: "Commit directly to current branch" },
      { label: "Per Phase", description: "Create branch for each phase (gsd/phase-{N}-{name})" },
      { label: "Per Milestone", description: "Create branch for entire milestone (gsd/{version}-{name})" }
    ]
  },
  {
    question: "Create git tags on milestone completion?",
    header: "Git Tagging",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Tag releases with version (e.g., v1.0) on milestone completion" },
      { label: "No", description: "Skip git tagging — use if your project doesn't use tags or uses a different release convention" }
    ]
  },
  {
    question: "Enable context window warnings? (injects advisory messages when context is getting full)",
    header: "Ctx Warnings",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Warn when context usage exceeds 65%. Helps avoid losing work." },
      { label: "No", description: "Disable warnings. Allows Claude to reach auto-compact naturally. Good for long unattended runs." }
    ]
  },
  {
    question: "Research best practices before asking questions? (web search during new-project and discuss-phase)",
    header: "Research Qs",
    multiSelect: false,
    options: [
      { label: "No (Recommended)", description: "Ask questions directly. Faster, uses fewer tokens." },
      { label: "Yes", description: "Search web for best practices before each question group. More informed questions but uses more tokens." }
    ]
  },
  {
    question: "Commit .planning/ files to git? (controls whether plans/artifacts are tracked in your repo)",
    header: "Commit Docs",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Commit .planning/ to git. Plans, research, and phase artifacts travel with the repo." },
      { label: "No", description: "Do not commit .planning/. Keep planning local only. Automatic when .planning/ is in .gitignore." }
    ]
  },
  {
    question: "Skip discuss-phase in autonomous mode? (use ROADMAP phase goals as spec)",
    header: "Skip Discuss",
    multiSelect: false,
    options: [
      { label: "No (Recommended)", description: "Run smart discuss before each phase — surfaces gray areas and captures decisions." },
      { label: "Yes", description: "Skip discuss in /gsd:autonomous — chain directly to plan. Best for backend/pipeline work where phase descriptions are the spec." }
    ]
  },
  {
    question: "Use git worktrees for parallel agent isolation?",
    header: "Worktrees",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Each parallel executor runs in its own worktree branch — no conflicts between agents." },
      { label: "No", description: "Disable worktree isolation. Agents run sequentially on the main working tree. Use if EnterWorktree creates branches from wrong base (known cross-platform issue)." }
    ]
  },
  {
    question: "Enable Intel? (queryable codebase intelligence via /gsd:map-codebase --query — builds a JSON index in .planning/intel/)",
    header: "Intel",
    multiSelect: false,
    options: [
      { label: "No (Recommended)", description: "Skip intel indexing. Use when codebase is small or intel queries are not needed." },
      { label: "Yes", description: "Enable /gsd:map-codebase --query commands. Builds and queries a JSON index of the codebase." }
    ]
  },
  {
    question: "Enable Graphify? (project knowledge graph via /gsd:graphify — builds a graph in .planning/graphs/)",
    header: "Graphify",
    multiSelect: false,
    options: [
      { label: "No (Recommended)", description: "Skip knowledge graph. Use when dependency graphs are not needed." },
      { label: "Yes", description: "Enable /gsd:graphify commands. Builds and queries a project knowledge graph." }
    ]
  },
  {
    question: "Auto-rebuild graph after main HEAD advances? (only effective if Graphify is enabled — #3347)",
    header: "Graph auto-update",
    multiSelect: false,
    options: [
      { label: "No (Recommended)", description: "Manual /gsd:graphify build only. Conservative default — opt in if you want fresh context on every /gsd:quick or /gsd:plan-phase." },
      { label: "Yes", description: "Auto-rebuild the graph in a detached background process after git commit/merge/pull/rebase --continue/cherry-pick on the default branch. Hook returns instantly; rebuild runs out-of-band. No-op if Graphify is disabled." }
    ]
  }
])
```
</step>

<step name="update_config">
Merge new settings into existing config.json:

```json
{
  ...existing_config,
  "model_profile": "quality" | "balanced" | "budget" | "adaptive" | "inherit",
  "commit_docs": true/false,
  "workflow": {
    "research": true/false,
    "plan_check": true/false,
    "verifier": true/false,
    "auto_advance": true/false,
    "nyquist_validation": true/false,
    "pattern_mapper": true/false,
    "ui_phase": true/false,
    "ui_safety_gate": true/false,
    "ai_integration_phase": true/false,
    "tdd_mode": true/false,
    "code_review": true/false,
    "code_review_depth": "quick" | "standard" | "deep",
    "ui_review": true/false,
    "text_mode": true/false,
    "research_before_questions": true/false,
    "discuss_mode": "discuss" | "assumptions",
    "skip_discuss": true/false,
    "use_worktrees": true/false   // never written as true on a non-Claude runtime; omitted entirely when the user chose "Leave unchanged" (#2486)
  },
  "plan_review": {
    "source_grounding": true/false
  },
  "intel": {
    "enabled": true/false
  },
  "graphify": {
    "enabled": true/false,
    "auto_update": true/false
  },
  "git": {
    "branching_strategy": "none" | "phase" | "milestone",
    "quick_branch_template": <string|null>,
    "create_tag": true/false
  },
  "hooks": {
    "context_warnings": true/false,
    "workflow_guard": true/false
  },
  "model_policy": {
    // Read-only in this flow — written only by /gsd:config --advanced (Section 8).
    // Listed here so safe-merge never clobbers an existing model_policy object.
    "provider": <existing|null>,
    "budget": <existing|null>,
    "high": <existing|null>,
    "medium": <existing|null>,
    "low": <existing|null>
  }
}
```

**Safe merge:** Apply each chosen value so unrelated keys are never clobbered. Use the appropriate write path per key:

- **Capability hook-gate keys** (owned by a capability in the registry — see `registry.configSchema`): write via the capability writer:
  ```bash
  gsd_run capability set <owner> --gate <key>=<value> [--config-dir "$RUNTIME_CONFIG_DIR"]
  ```
  The capability-owned keys written by this workflow and their owners are:
  | Key | Owner capability |
  |---|---|
  | `workflow.research` | `research` |
  | `workflow.nyquist_validation` | `nyquist` |
  | `workflow.pattern_mapper` | `pattern-mapper` |
  | `workflow.ui_phase` | `ui` |
  | `workflow.ui_safety_gate` | `ui` |
  | `workflow.ai_integration_phase` | `ai-integration` |
  | `workflow.tdd_mode` | `tdd` |
  | `workflow.code_review` | `code-review` |
  | `workflow.code_review_depth` | `code-review` |
  | `workflow.ui_review` | `ui` |
  | `intel.enabled` | `intel` |
  | `graphify.enabled` | `graphify` |

  `code_review_depth` is written only if the `code_review` question was answered `on`; otherwise leave the existing value in place.

- **Non-capability keys** (`model_profile`, `commit_docs`, `workflow.plan_check`, `workflow.verifier`, `workflow.auto_advance`, `workflow.text_mode`, `workflow.research_before_questions`, `workflow.discuss_mode`, `workflow.skip_discuss`, `workflow.use_worktrees`, `plan_review.source_grounding`, `graphify.auto_update`, `git.*`, `hooks.*`, `model_policy.*`): write via `gsd_run query config-set <key.path> <value>` as before.

`model_profile` is written on Q1 "Adaptive (Recommended)" (→ adaptive) or Q1 "Inherit" (→ inherit) immediately; for Q1 "Standard tier…", `model_profile` is written from Q2's answer. If Q1 = "Standard tier…" but Q2 is cancelled, leave the existing `model_profile` value unchanged — do not write any new value.

Write updated config to `$GSD_CONFIG_PATH` (the workstream-aware path resolved in `ensure_and_load_config`). Never hardcode `.planning/config.json` — workstream installs route to `.planning/workstreams/<slug>/config.json`.
</step>

<step name="save_as_defaults">
Ask whether to save these settings as global defaults for future projects:

```
AskUserQuestion([
  {
    question: "Save these as default settings for all new projects?",
    header: "Defaults",
    multiSelect: false,
    options: [
      { label: "Yes", description: "New projects start with these settings (saved to ~/.gsd/defaults.json)" },
      { label: "No", description: "Only apply to this project" }
    ]
  }
])
```

If "Yes": write the same config object (minus project-specific fields like `brave_search`) to `~/.gsd/defaults.json`:

```bash
mkdir -p ~/.gsd
```

Write `~/.gsd/defaults.json` with:
```json
{
  "mode": <current>,
  "granularity": <current>,
  "model_profile": <current>,
  "commit_docs": <current>,
  "parallelization": <current>,
  "branching_strategy": <current>,
  "quick_branch_template": <current>,
  "workflow": {
    "research": <current>,
    "plan_check": <current>,
    "verifier": <current>,
    "auto_advance": <current>,
    "nyquist_validation": <current>,
    "pattern_mapper": <current>,
    "ui_phase": <current>,
    "ui_safety_gate": <current>,
    "ai_integration_phase": <current>,
    "tdd_mode": <current>,
    "code_review": <current>,
    "code_review_depth": <current>,
    "ui_review": <current>,
    "skip_discuss": <current>
  },
  "plan_review": {
    "source_grounding": <current>
  },
  "intel": {
    "enabled": <current>
  },
  "graphify": {
    "enabled": <current>,
    "auto_update": <current>
  }
}
```
</step>

<step name="confirm">
Display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► SETTINGS UPDATED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Setting              | Value |
|----------------------|-------|
| Model Profile        | {quality/balanced/budget/adaptive/inherit} |
| Plan Researcher      | {On/Off} |
| Plan Checker         | {On/Off} |
| Pattern Mapper       | {On/Off} |
| Execution Verifier   | {On/Off} |
| TDD Mode             | {On/Off} |
| Code Review          | {On/Off} |
| Plan Drift Guard     | {On/Off} |
| Code Review Depth    | {quick/standard/deep} |
| UI Review            | {On/Off} |
| Commit Docs          | {On/Off} |
| Intel                | {On/Off} |
| Graphify             | {On/Off} |
| Auto-Advance         | {On/Off} |
| Nyquist Validation   | {On/Off} |
| UI Phase             | {On/Off} |
| UI Safety Gate       | {On/Off} |
| AI Integration Phase | {On/Off} |
| Git Branching        | {None/Per Phase/Per Milestone} |
| Git Tagging          | {On/Off} |
| Skip Discuss         | {On/Off} |
| Context Warnings     | {On/Off} |
| Saved as Defaults    | {Yes/No} |

These settings apply to future /gsd:plan-phase and /gsd:execute-phase runs.

Quick commands:
- /gsd:config --integrations — configure API keys (Brave/Firecrawl/Exa), review.models CLI routing, and agent_skills injection
- /gsd:config --profile <profile> — switch model profile
- /gsd:plan-phase --research — force research
- /gsd:plan-phase --skip-research — skip research
- /gsd:plan-phase --skip-verify — skip plan check
- /gsd:config --advanced — power-user tuning (plan bounce, timeouts, branch templates, cross-AI, context window, model policy)
```
</step>

</process>

<success_criteria>
- [ ] Current config read
- [ ] User presented with 24 settings (profile + workflow toggles + features + git branching + git tagging + ctx warnings), grouped into six sections: Planning, Execution, Docs & Output, Features, Model & Pipeline, Misc. `code_review_depth` is conditional on `code_review=on`. Model profile uses a two-question split (Q1: Adaptive / Standard tier / Inherit; Q2: Quality / Balanced / Budget — only when Standard tier chosen) to stay within the 4-option AskUserQuestion cap while exposing all 5 valid profiles (#3784). Drift Guard (`plan_review.source_grounding`) is in the Planning section.
- [ ] Config updated with model_profile, workflow, and git sections
- [ ] User offered to save as global defaults (~/.gsd/defaults.json)
- [ ] Changes confirmed to user
</success_criteria>

Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<purpose>
Interactive configuration of GSD power-user knobs — plan bounce, node repair, subagent timeouts,
inline plan threshold, cross-AI execution, base branch, branch templates, response language,
context window, gitignored search, graphify build timeout, runtime model tier overrides, and
model policy configuration (provider + budget → canonical tier mapping, or manual model ID
assignment per cost tier).

This is a companion to `/gsd:settings` — the common-case prompt there covers model profile,
research/plan_check/verifier toggles, branching strategy, UI/AI phase gates, and worktree
isolation. This advanced command covers everything else that is user-settable, grouped into
eight sections so each prompt batch stays cognitively scoped. Every answer pre-selects the
current value; numeric-input answers that are non-numeric are rejected and re-prompted.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="ensure_and_load_config">
Ensure config exists and resolve the workstream-aware config path (mirrors `settings.md`):

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
gsd_run query config-ensure-section
if [[ -z "${GSD_CONFIG_PATH:-}" ]]; then
  if [[ -f .planning/active-workstream ]]; then
    WS=$(tr -d '\n\r' < .planning/active-workstream)
    GSD_CONFIG_PATH=".planning/workstreams/${WS}/config.json"
  else
    GSD_CONFIG_PATH=".planning/config.json"
  fi
fi
```

All subsequent reads and writes go through `$GSD_CONFIG_PATH`. Never hardcode
`.planning/config.json` — workstream installs must route to their own config file.
</step>

<step name="read_current">
```bash
cat "$GSD_CONFIG_PATH"
```

Parse the following current values. If a key is absent, fall back to the documented default
shown in parentheses:

Planning Tuning:
- `workflow.plan_bounce` (default: `false`)
- `workflow.plan_bounce_passes` (default: `2`)
- `workflow.plan_bounce_script` (default: `null`)
- `workflow.subagent_timeout` (default: `300000`)
- `workflow.inline_plan_threshold` (default: `2`)

Execution Tuning:
- `workflow.node_repair` (default: `true`)
- `workflow.node_repair_budget` (default: `2`)
- `workflow.auto_prune_state` (default: `false`)

Discussion Tuning:
- `workflow.max_discuss_passes` (default: `3`)

Cross-AI Execution:
- `workflow.cross_ai_execution` (default: `false`)
- `workflow.cross_ai_command` (default: `null`)
- `workflow.cross_ai_timeout` (default: `300`)

Git Customization:
- `git.base_branch` (default: `main`)
- `git.phase_branch_template` (default: `gsd/phase-{phase}-{slug}`)
- `git.milestone_branch_template` (default: `gsd/{milestone}-{slug}`)

Runtime / Output:
- `response_language` (default: `null`)
- `context_window` (default: `200000`)
- `search_gitignored` (default: `false`)
- `graphify.build_timeout` (default: `300`)

Runtime Model Tiers:
- `runtime` (default: `null` — reads as `"claude"`)
- `model_profile_overrides.<runtime>.opus` (default: built-in for the runtime, or absent)
- `model_profile_overrides.<runtime>.sonnet` (default: built-in for the runtime, or absent)
- `model_profile_overrides.<runtime>.haiku` (default: built-in for the runtime, or absent)

Model Policy:
- `model_policy.provider` (default: `null` — known values: anthropic, anthropic-fable, openai, google, qwen)
- `model_policy.budget` (default: `null` — known values: high, medium, low)
- `model_policy.high` (default: `null` — model ID for the high-cost tier; used by generic provider path)
- `model_policy.medium` (default: `null` — model ID for the medium-cost tier; used by generic provider path)
- `model_policy.low` (default: `null` — model ID for the low-cost tier; used by generic provider path)

Each field's **current value is pre-selected** in the prompt rendering below. When the
current value is absent from the config, render the documented default as the pre-selected
option so the user sees what the effective value is.
</step>

<step name="present_settings">

**Text mode (`workflow.text_mode: true` or `--text` flag):** Set `TEXT_MODE=true` if `--text` is
in `$ARGUMENTS` OR `text_mode` is true in config. When `TEXT_MODE=true`, replace every
`AskUserQuestion` call below with a plain-text numbered list and ask the user to type the
choice number or free-text value.

**Numeric-input validation.** For any numeric field (`*_passes`, `*_budget`, `*_timeout`,
`*_threshold`, `context_window`, `graphify.build_timeout`), if the user types a value that
is not a non-negative integer, the workflow MUST reject it, state which value was invalid,
and re-prompt that single field. The minimum accepted value is field-specific and is stated
in each field's prompt below — `workflow.plan_bounce_passes` and `workflow.max_discuss_passes`
require `>= 1`; all other numeric fields accept `>= 0`. An empty input means "keep current"
— the existing value is retained. Non-numeric input is never silently coerced.

**Free-text validation.** For branch template fields (`git.phase_branch_template`,
`git.milestone_branch_template`), if the user supplies a non-default value, it MUST be
non-empty and SHOULD contain at least one `{placeholder}`. A template missing placeholders
is rejected with a message explaining the available variables (`{phase}`, `{slug}`,
`{milestone}`) and re-prompted. An empty input means "keep current."

**Null-allowed fields.** For `response_language`, `workflow.plan_bounce_script`,
`workflow.cross_ai_command`: an empty input clears the field (`null`). A non-empty input is
stored verbatim as a string.

---

### Section 1 — Planning Tuning

```text
AskUserQuestion([
  {
    question: "Run external plan-bounce validator against generated PLAN.md? (current: <value or false>)",
    header: "Plan Bounce",
    multiSelect: false,
    options: [
      { label: "No (default: false)", description: "Skip external plan validation." },
      { label: "Yes", description: "Pipe each PLAN.md through `plan_bounce_script` and block on non-zero exit." }
    ]
  },
  {
    question: "How many plan-bounce passes? (current: <value or 2>)",
    header: "Bounce Passes",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave the existing value unchanged." },
      { label: "Enter number", description: "Type an integer >= 1. Non-numeric input is rejected and re-prompted. Default: 2" }
    ]
  },
  {
    question: "Path to plan-bounce validation script? (current: <value or null>)",
    header: "Bounce Script",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave existing path unchanged." },
      { label: "Clear (null)", description: "Unset the script path." },
      { label: "Enter path", description: "Type an absolute or repo-relative path. Receives PLAN.md path as first argument." }
    ]
  },
  {
    question: "Subagent timeout (milliseconds)? (current: <value or 300000>)",
    header: "Subagent Timeout",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave timeout unchanged." },
      { label: "Enter milliseconds", description: "Integer number of milliseconds. Non-numeric rejected. Default: 300000 (5 minutes)." }
    ]
  },
  {
    question: "Inline plan threshold — tasks allowed inline before splitting to PLAN.md? (current: <value or 3>)",
    header: "Inline Plan Threshold",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave threshold unchanged." },
      { label: "Enter number", description: "Integer count. Non-numeric rejected. Default: 3" }
    ]
  }
])
```

### Section 2 — Execution Tuning

```text
AskUserQuestion([
  {
    question: "Enable autonomous node repair on verification failure? (current: <value or true>)",
    header: "Node Repair",
    multiSelect: false,
    options: [
      { label: "Yes (default: true)", description: "Executor retries failed tasks up to the repair budget." },
      { label: "No", description: "Stop on first verification failure." }
    ]
  },
  {
    question: "Maximum node-repair attempts per failed task? (current: <value or 2>)",
    header: "Repair Budget",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave existing budget unchanged." },
      { label: "Enter number", description: "Integer >= 0. Non-numeric rejected. Default: 2" }
    ]
  },
  {
    question: "Auto-prune stale STATE.md entries at phase boundaries? (current: <value or false>)",
    header: "Auto Prune",
    multiSelect: false,
    options: [
      { label: "No (default: false)", description: "Prompt before pruning." },
      { label: "Yes", description: "Prune stale entries without prompting." }
    ]
  }
])
```

### Section 3 — Discussion Tuning

```text
AskUserQuestion([
  {
    question: "Maximum discuss-phase question rounds? (current: <value or 3>)",
    header: "Max Discuss Passes",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave existing value unchanged." },
      { label: "Enter number", description: "Integer >= 1. Non-numeric rejected. Default: 3. Prevents infinite discussion loops in headless mode." }
    ]
  }
])
```

### Section 4 — Cross-AI Execution

```text
AskUserQuestion([
  {
    question: "Delegate phase execution to an external AI CLI? (current: <value or false>)",
    header: "Cross-AI",
    multiSelect: false,
    options: [
      { label: "No (default: false)", description: "Use local executor agents." },
      { label: "Yes", description: "Pipe phase prompt to `cross_ai_command` via stdin. Requires command to be set." }
    ]
  },
  {
    question: "Cross-AI command template? (current: <value or null>)",
    header: "Cross-AI Command",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave command unchanged." },
      { label: "Clear (null)", description: "Unset the command." },
      { label: "Enter command", description: "Shell command receiving phase prompt via stdin. Must produce SUMMARY.md-compatible output." }
    ]
  },
  {
    question: "Cross-AI timeout (seconds)? (current: <value or 300>)",
    header: "Cross-AI Timeout",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave timeout unchanged." },
      { label: "Enter seconds", description: "Integer seconds. Non-numeric rejected. Default: 300" }
    ]
  }
])
```

### Section 5 — Git Customization

```text
AskUserQuestion([
  {
    question: "Git base branch? (current: <value or main>)",
    header: "Base Branch",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave base branch unchanged." },
      { label: "Enter branch name", description: "e.g., main, master, develop. Integration branch for phase/milestone branches." }
    ]
  },
  {
    question: "Phase branch template? (current: <value or gsd/phase-{phase}-{slug}>)",
    header: "Phase Template",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave template unchanged." },
      { label: "Enter template", description: "Non-empty string with at least one placeholder. Available: {phase}, {slug}. Non-default values missing placeholders are rejected." }
    ]
  },
  {
    question: "Milestone branch template? (current: <value or gsd/{milestone}-{slug}>)",
    header: "Milestone Template",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave template unchanged." },
      { label: "Enter template", description: "Non-empty string. Available placeholders: {milestone}, {slug}. Non-default values missing placeholders are rejected." }
    ]
  }
])
```

### Section 6 — Runtime / Output

```text
AskUserQuestion([
  {
    question: "Response language for agent output? (current: <value or null>)",
    header: "Language",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave unchanged." },
      { label: "Clear (null)", description: "Use Claude default (English)." },
      { label: "Enter language", description: "Free-text language name or code (e.g., Japanese, pt, ko). Propagates to spawned agents." }
    ]
  },
  {
    question: "Context window size (tokens)? (current: <value or 200000>)",
    header: "Context Window",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave unchanged." },
      { label: "Enter number", description: "Integer. Non-numeric rejected. Default: 200000. Use 1000000 for 1M-context models. Values >= 500000 enable adaptive enrichment." }
    ]
  },
  {
    question: "Include gitignored files in broad searches? (current: <value or false>)",
    header: "Search Gitignored",
    multiSelect: false,
    options: [
      { label: "No (default: false)", description: "Respect .gitignore during searches." },
      { label: "Yes", description: "Add --no-ignore to broad searches (includes .planning/)." }
    ]
  },
  {
    question: "Graphify build timeout (seconds)? (current: <value or 300>)",
    header: "Graphify Timeout",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave timeout unchanged." },
      { label: "Enter seconds", description: "Integer seconds. Non-numeric rejected. Default: 300" }
    ]
  }
])
```

### Section 7 — Runtime Model Tiers

This section lets the user inspect and override the built-in model IDs GSD resolves for each
profile tier (`opus` / `sonnet` / `haiku`) on their configured runtime.

**Step A — Show current runtime and built-in defaults:**

Read `runtime` from the config (or treat as `"claude"` if absent). Look up the built-in
tier map from the table below. For each tier, also read the current override from
`model_profile_overrides.<runtime>.<tier>` if present.

Built-in tier defaults by runtime:

| Runtime    | `opus`                        | `sonnet`                        | `haiku`                       |
|------------|-------------------------------|---------------------------------|-------------------------------|
| `claude`   | `claude-opus-4-8`             | `claude-sonnet-5`             | `claude-haiku-4-5`            |
| `codex`    | `gpt-5.6-sol`                 | `gpt-5.6-terra`                 | `gpt-5.6-luna`                |
| `gemini`   | `gemini-3.1-pro-preview`      | `gemini-3-flash`                | `gemini-2.5-flash-lite`       |
| `qwen`     | `qwen3-max-2026-01-23`        | `qwen3-coder-plus`              | `qwen3-coder-next`            |
| `opencode` | `anthropic/claude-opus-4-8`   | `anthropic/claude-sonnet-5`   | `anthropic/claude-haiku-4-5`  |
| `copilot`  | `claude-opus-4-8`             | `claude-sonnet-5`             | `claude-haiku-4-5`            |
| `hermes`   | `anthropic/claude-opus-4-8`   | `anthropic/claude-sonnet-5`   | `anthropic/claude-haiku-4-5`  |
| `kilo`     | `anthropic/claude-opus-4-8`   | `anthropic/claude-sonnet-5`   | `anthropic/claude-haiku-4-5`  |
| `pi`       | `claude-opus-4-8`             | `claude-sonnet-5`             | `claude-haiku-4-5`            |
| Group B (`cline`, `cursor`, `windsurf`, `augment`, `trae`, `codebuddy`, `antigravity`) | (no built-in default — your runtime handles model selection) | | |

Display a table to the user showing the effective configuration:

```text
Runtime model tiers — runtime: <current runtime or "claude (default)">

| Tier   | Built-in default                  | Current override (if any)         |
|--------|-----------------------------------|-----------------------------------|
| opus   | <built-in or "(no built-in)">     | <override value or "(none)">      |
| sonnet | <built-in or "(no built-in)">     | <override value or "(none)">      |
| haiku  | <built-in or "(no built-in)">     | <override value or "(none)">      |
```

For Group B runtimes (those without a built-in default), show `(no built-in default — your runtime handles model selection)` in the built-in column.

**Step B — Let the user choose a runtime (optional):**

```text
AskUserQuestion([
  {
    question: "Which runtime group do you want to configure tier overrides for? (current: <runtime or 'claude'>)",
    header: "Runtime Group",
    multiSelect: false,
    options: [
      { label: "Keep current (<runtime>)", description: "Configure overrides for the current runtime." },
      { label: "Common runtimes", description: "claude, codex, gemini, qwen" },
      { label: "Additional runtimes", description: "opencode, copilot, hermes, kilo" },
      { label: "Other (Group B or custom)", description: "cline, cursor, windsurf, augment, trae, codebuddy, antigravity, or a custom runtime string." }
    ]
  }
])
```

If "Common runtimes" is selected, ask:

```text
AskUserQuestion([
  {
    question: "Choose the runtime:",
    header: "Common",
    multiSelect: false,
    options: [
      { label: "claude", description: "Claude Code / Anthropic CLI." },
      { label: "codex", description: "OpenAI Codex CLI." },
      { label: "gemini", description: "Gemini CLI." },
      { label: "qwen", description: "Qwen CLI." }
    ]
  }
])
```

If "Additional runtimes" is selected, ask:

```text
AskUserQuestion([
  {
    question: "Choose the runtime:",
    header: "Additional",
    multiSelect: false,
    options: [
      { label: "opencode", description: "OpenCode (uses anthropic/ prefix)." },
      { label: "copilot", description: "GitHub Copilot." },
      { label: "hermes", description: "Hermes (uses anthropic/ prefix)." },
      { label: "kilo", description: "Kilo Code (uses anthropic/ prefix)." }
    ]
  }
])
```

If "Other (Group B or custom)" is selected, prompt the user to enter the runtime name as a free-text string.
If the selected runtime differs from the stored `runtime` key, update `runtime` via
`gsd_run query config-set runtime <value>` before proceeding to Step C.

**Step C — Configure tier overrides for the selected runtime:**

```text
AskUserQuestion([
  {
    question: "Override for opus tier? Built-in: <opus default or '(no built-in)'>  Current: <override or '(none)'>",
    header: "Opus Override",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave unchanged (uses built-in default if no override)." },
      { label: "Clear override", description: "Remove any existing override; fall back to built-in." },
      { label: "Enter model ID", description: "Type the exact model ID string to use for opus-tier agents on this runtime." }
    ]
  },
  {
    question: "Override for sonnet tier? Built-in: <sonnet default or '(no built-in)'>  Current: <override or '(none)'>",
    header: "Sonnet Override",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave unchanged." },
      { label: "Clear override", description: "Remove any existing override; fall back to built-in." },
      { label: "Enter model ID", description: "Type the exact model ID string to use for sonnet-tier agents on this runtime." }
    ]
  },
  {
    question: "Override for haiku tier? Built-in: <haiku default or '(no built-in)'>  Current: <override or '(none)'>",
    header: "Haiku Override",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave unchanged." },
      { label: "Clear override", description: "Remove any existing override; fall back to built-in." },
      { label: "Enter model ID", description: "Type the exact model ID string to use for haiku-tier agents on this runtime." }
    ]
  }
])
```

**Step D — Apply the changes:**

For each tier where the user chose "Enter model ID":
```bash
gsd_run query config-set model_profile_overrides.<runtime>.<tier> "<model-id>"
```

For each tier where the user chose "Clear override", remove the key by setting it to null:
```bash
gsd_run query config-set model_profile_overrides.<runtime>.<tier> null
```

"Keep current" selections are skipped entirely. Never write a key the user did not explicitly
change.

</step>

<step name="update_config">
Merge the new settings into the existing config at `$GSD_CONFIG_PATH`. This merge is the
core correctness invariant: **preserve every unrelated key** — do not clobber siblings.

Apply each selected value via `gsd_run query config-set <key> <value>` so the central
validator (`isValidConfigKey`) accepts the write and the deep-merge preserves unrelated
keys and sibling sub-objects.

```bash
# Example — only write keys the user changed. "Keep current" selections are skipped.
gsd_run query config-set workflow.plan_bounce_passes 5
gsd_run query config-set workflow.subagent_timeout 300000
gsd_run query config-set git.base_branch main
gsd_run query config-set context_window 1000000
# Runtime model tier examples:
gsd_run query config-set runtime gemini
gsd_run query config-set model_profile_overrides.gemini.opus gemini-3-ultra
gsd_run query config-set model_profile_overrides.gemini.haiku null
```

Conceptual shape after merge (unchanged top-level keys like `model_profile`,
`granularity`, `mode`, `brave_search`, `agent_skills.*`, `hooks.context_warnings`, and
anything not listed in Sections 1–8 MUST survive the update):

```json
{
  ...existing_config,
  "workflow": {
    ...existing_workflow,
    "plan_bounce": <new|existing>,
    "plan_bounce_passes": <new|existing>,
    "plan_bounce_script": <new|existing|null>,
    "subagent_timeout": <new|existing>,
    "inline_plan_threshold": <new|existing>,
    "node_repair": <new|existing>,
    "node_repair_budget": <new|existing>,
    "auto_prune_state": <new|existing>,
    "max_discuss_passes": <new|existing>,
    "cross_ai_execution": <new|existing>,
    "cross_ai_command": <new|existing|null>,
    "cross_ai_timeout": <new|existing>
  },
  "git": {
    ...existing_git,
    "base_branch": <new|existing>,
    "phase_branch_template": <new|existing>,
    "milestone_branch_template": <new|existing>
  },
  "response_language": <new|existing|null>,
  "context_window": <new|existing>,
  "search_gitignored": <new|existing>,
  "graphify": {
    ...existing_graphify,
    "build_timeout": <new|existing>
  },
  "runtime": <new|existing|null>,
  "model_profile_overrides": {
    ...existing_model_profile_overrides,
    "<runtime>": {
      ...existing_runtime_overrides,
      "opus": <new|existing|null>,
      "sonnet": <new|existing|null>,
      "haiku": <new|existing|null>
    }
  },
  "model_policy": {
    ...existing_model_policy,
    "provider": <new|existing|null>,
    "budget": <new|existing|null>,
    "high": <new|existing|null>,
    "medium": <new|existing|null>,
    "low": <new|existing|null>
  }
}
```

Never emit a full overwrite of the file that omits keys the user did not touch. Always
route each write through `gsd_run query config-set` so sibling preservation is handled by
the central setter.
</step>

<step name="model_policy">

### Section 8 — Model Policy

This section configures the `model_policy` key in `.planning/config.json`. Model policy
defines which AI models GSD uses at each cost tier (low / medium / high), independently
of the `runtime` and `model_profile` selections above. Two paths are offered:

- **Known provider:** choose a provider and a budget level; GSD materializes the canonical
  tier mapping for that provider.
- **Generic provider:** enter low / medium / high model IDs manually.

**Step A — Read and display the current model policy:**

```bash
cat "$GSD_CONFIG_PATH" | python3 -c "import sys,json; c=json.load(sys.stdin); mp=c.get('model_policy',{}); print(json.dumps(mp,indent=2))" 2>/dev/null || echo "{}"
```

Display the current values (or "(unset)" for any absent field) before asking:

```text
Current model_policy:
  provider : <value or "(unset)">
  budget   : <value or "(unset)">
  low      : <value or "(unset)">
  medium   : <value or "(unset)">
  high     : <value or "(unset)">
```

**Step B — Choose configuration path:**

```text
AskUserQuestion([
  {
    question: "How do you want to configure the model policy?",
    header: "Model Policy",
    multiSelect: false,
    options: [
      { label: "Known provider", description: "Choose a provider (Claude / OpenAI / Gemini / Qwen) and a budget level — GSD writes the canonical tier mapping automatically." },
      { label: "Generic provider", description: "Enter low / medium / high model IDs manually for any provider or custom deployment." },
      { label: "Keep current", description: "Leave model_policy unchanged." }
    ]
  }
])
```

**If "Keep current" is selected:** skip Steps C–E and move on to the confirm step.

**Step C — Known-provider path:**

```text
AskUserQuestion([
  {
    question: "Which provider?",
    header: "Provider",
    multiSelect: false,
    options: [
      { label: "anthropic", description: "claude-opus-4-8 / claude-sonnet-5 / claude-haiku-4-5 (Anthropic / Claude)" },
      { label: "anthropic-fable", description: "claude-fable-5 / claude-sonnet-5 / claude-haiku-4-5 (Anthropic / Claude Fable opt-in)" },
      { label: "openai", description: "gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna (OpenAI / Codex)" },
      { label: "Other known provider", description: "Type google or qwen; both still use the canonical tier mapping." }
    ]
  }
])
```

If the user selects "Other known provider", ask them to type `google` or `qwen`.
Use the typed value as the provider. After the user picks or types a provider, ask:

```text
AskUserQuestion([
  {
    question: "Which budget level?",
    header: "Budget",
    multiSelect: false,
    options: [
      { label: "high", description: "All tiers use the highest-quality model for the chosen provider. Highest cost." },
      { label: "medium", description: "High tier → top model; medium → mid model; low → cheapest model. Best cost/quality ratio." },
      { label: "low", description: "All tiers use the cheapest model for the chosen provider. Lowest cost." }
    ]
  }
])
```

Canonical tier mappings by provider and budget:

| Provider  | Budget | high                       | medium                     | low                        |
|-----------|--------|----------------------------|----------------------------|----------------------------|
| anthropic | high   | claude-opus-4-8            | claude-opus-4-8            | claude-sonnet-5          |
| anthropic | medium | claude-opus-4-8            | claude-sonnet-5          | claude-haiku-4-5           |
| anthropic | low    | claude-haiku-4-5           | claude-haiku-4-5           | claude-haiku-4-5           |
| anthropic-fable | high   | claude-fable-5             | claude-fable-5             | claude-sonnet-5          |
| anthropic-fable | medium | claude-opus-4-8            | claude-sonnet-5          | claude-haiku-4-5           |
| anthropic-fable | low    | claude-haiku-4-5           | claude-haiku-4-5           | claude-haiku-4-5           |
| openai    | high   | gpt-5.6-sol                | gpt-5.6-sol                | gpt-5.6-sol                |
| openai    | medium | gpt-5.6-sol                | gpt-5.6-terra              | gpt-5.6-luna               |
| openai    | low    | gpt-5.6-luna               | gpt-5.6-luna               | gpt-5.6-luna               |
| google    | high   | gemini-3.1-pro-preview     | gemini-3.1-pro-preview     | gemini-3.1-pro-preview     |
| google    | medium | gemini-3.1-pro-preview     | gemini-3-flash             | gemini-2.5-flash-lite      |
| google    | low    | gemini-2.5-flash-lite      | gemini-2.5-flash-lite      | gemini-2.5-flash-lite      |
| qwen      | high   | qwen3-max-2026-01-23       | qwen3-max-2026-01-23       | qwen3-max-2026-01-23       |
| qwen      | medium | qwen3-max-2026-01-23       | qwen3-coder-plus           | qwen3-coder-next           |
| qwen      | low    | qwen3-coder-next           | qwen3-coder-next           | qwen3-coder-next           |

Look up the selected (provider, budget) row and proceed to Step E to write those values.

> **claude runtime note:** On the default `claude` runtime, policy-resolved model IDs (e.g. `claude-fable-5`) are mapped to Claude Code agent aliases (`fable`, `opus`, `sonnet`, `haiku`); an ID with no corresponding alias emits a stderr warning and falls back to the configured tier alias.

**Step D — Generic-provider path:**

Prompt the user to enter each model ID as a free-text input. An empty input means "keep
the current value for that tier." Validate that non-empty inputs are non-blank strings
(no whitespace-only values); if validation fails, re-prompt that single field.

```text
AskUserQuestion([
  {
    question: "Model ID for the HIGH-cost tier? (most capable model — used for heavy reasoning tasks)",
    header: "High-tier model",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave unchanged (current: <model_policy.high or '(unset)'>)." },
      { label: "Enter model ID", description: "Type the exact model identifier. Non-blank string required." }
    ]
  },
  {
    question: "Model ID for the MEDIUM-cost tier? (balanced model — used for most agents)",
    header: "Medium-tier model",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave unchanged (current: <model_policy.medium or '(unset)'>)." },
      { label: "Enter model ID", description: "Type the exact model identifier." }
    ]
  },
  {
    question: "Model ID for the LOW-cost tier? (cheapest model — used for lightweight/fast tasks)",
    header: "Low-tier model",
    multiSelect: false,
    options: [
      { label: "Keep current", description: "Leave unchanged (current: <model_policy.low or '(unset)'>)." },
      { label: "Enter model ID", description: "Type the exact model identifier." }
    ]
  }
])
```

Set `provider = "custom"` and `budget = null` when writing the generic-provider result.
Proceed to Step E.

**Step E — Write model_policy to config:**

```bash
# Known-provider path — write all four keys atomically:
gsd_run query config-set model_policy.provider "<provider>"   # e.g., anthropic / anthropic-fable / openai / google / qwen
gsd_run query config-set model_policy.budget   "<budget>"    # high / medium / low
gsd_run query config-set model_policy.high     "<high-id>"
gsd_run query config-set model_policy.medium   "<medium-id>"
gsd_run query config-set model_policy.low      "<low-id>"

# Generic-provider path — write only tiers the user changed ("Keep current" skipped):
gsd_run query config-set model_policy.provider "custom"
gsd_run query config-set model_policy.budget   null
# Per-tier writes for each non-"Keep current" answer:
gsd_run query config-set model_policy.high     "<high-id>"   # omit if user chose "Keep current"
gsd_run query config-set model_policy.medium   "<medium-id>" # omit if user chose "Keep current"
gsd_run query config-set model_policy.low      "<low-id>"    # omit if user chose "Keep current"
```

Never write a tier the user explicitly chose to keep; the existing value must survive.

</step>

<step name="confirm">
Display:

```text
### GSD ► ADVANCED SETTINGS UPDATED

| Setting                                    | Value |
|--------------------------------------------|-------|
| workflow.plan_bounce                       | {on/off} |
| workflow.plan_bounce_passes                | {n} |
| workflow.plan_bounce_script                | {path/null} |
| workflow.subagent_timeout                  | {milliseconds} |
| workflow.inline_plan_threshold             | {n} |
| workflow.node_repair                       | {on/off} |
| workflow.node_repair_budget                | {n} |
| workflow.auto_prune_state                  | {on/off} |
| workflow.max_discuss_passes                | {n} |
| workflow.cross_ai_execution                | {on/off} |
| workflow.cross_ai_command                  | {cmd/null} |
| workflow.cross_ai_timeout                  | {seconds} |
| git.base_branch                            | {branch} |
| git.phase_branch_template                  | {template} |
| git.milestone_branch_template              | {template} |
| response_language                          | {lang/null} |
| context_window                             | {tokens} |
| search_gitignored                          | {on/off} |
| graphify.build_timeout                     | {seconds} |
| runtime                                    | {runtime/null} |
| model_profile_overrides.<runtime>.opus     | {model/built-in/null} |
| model_profile_overrides.<runtime>.sonnet   | {model/built-in/null} |
| model_profile_overrides.<runtime>.haiku    | {model/built-in/null} |
| effort.default                             | {low/medium/high/xhigh/max} |
| effort.routing_tier_defaults.light         | {low/medium/high/xhigh/max} |
| effort.routing_tier_defaults.standard      | {low/medium/high/xhigh/max} |
| effort.routing_tier_defaults.heavy         | {low/medium/high/xhigh/max} |
| effort.agent_overrides.<agent-id>          | {low/medium/high/xhigh/max} |
| fast_mode.enabled                          | {true/false} |
| fast_mode.routing_tier_defaults.light      | {true/false} |
| fast_mode.routing_tier_defaults.standard   | {true/false} |
| fast_mode.routing_tier_defaults.heavy      | {true/false} |
| fast_mode.agent_overrides.<agent-id>       | {true/false} |
| model_policy.provider                      | {anthropic/anthropic-fable/openai/google/qwen/custom/null} |
| model_policy.budget                        | {high/medium/low/null} |
| model_policy.high                          | {model-id/null} |
| model_policy.medium                        | {model-id/null} |
| model_policy.low                           | {model-id/null} |

These settings apply to future /gsd:plan-phase, /gsd:execute-phase, /gsd:discuss-phase,
and /gsd:ship runs.

For common-case toggles (model profile, research/plan_check/verifier, branching strategy,
UI/AI phase gates), use /gsd:settings.
```
</step>

</process>

<success_criteria>
- [ ] Current config read from resolved `$GSD_CONFIG_PATH`
- [ ] Eight sections rendered (Planning, Execution, Discussion, Cross-AI, Git, Runtime/Output, Runtime Model Tiers, Model Policy)
- [ ] Every field pre-selected to its current value (or documented default if absent)
- [ ] Numeric inputs validated — non-numeric rejected and re-prompted
- [ ] Branch-template inputs validated — non-default must contain a placeholder
- [ ] Null-allowed fields accept an empty input as a clear
- [ ] Writes routed through `gsd_run query config-set` so unrelated keys are preserved
- [ ] Section 7 shows current runtime and built-in tier table
- [ ] Group B runtimes display "(no built-in default — your runtime handles model selection)"
- [ ] Override set/clear/keep paths all work correctly for each tier
- [ ] Section 8 (Model Policy) offers three top-level choices: Known provider, Generic provider, Keep current
- [ ] Known-provider path: provider + budget → canonical tier mapping written to model_policy.{provider,budget,high,medium,low}
- [ ] Generic-provider path: per-tier manual model IDs; "Keep current" tiers are never written; provider=custom budget=null
- [ ] model_policy written under the model_policy key in config.json, never as a top-level flat key
- [ ] Confirmation table rendered listing all fields including model_policy.{provider,budget,high,medium,low}
</success_criteria>

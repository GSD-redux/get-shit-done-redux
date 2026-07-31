<purpose>
GSD smart entry — the state-aware front door. Detect the current project situation via `gsd_run smart-entry --json`, present a short menu of the right next actions, and dispatch to exactly one existing GSD command. This is a launcher/router only; it never does the work itself.

This is a *menu* front door, not a second router. For in-project forward motion (planning → executing → verify-pending) the recommended action is `/gsd:progress --next`, which delegates to the single gated advancement engine (`workflows/next.md`: Route 0 resume-incomplete-phase + Gates 1-3). smart-entry adds value only where `--next` cannot reach: pre-project, remediation (paused/blocked/verify-failed), and lifecycle exits (idle-stranded/complete). See `docs/adr/1787-gsd-next-smart-entry.md`.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's `execution_context` before starting.
</required_reading>

<process>

<step name="text_mode">
**TEXT_MODE handling (non-Claude runtimes).**

Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
</step>

<step name="resolve">
**Resolve the gsd_run shim.**

Run this resolver block exactly. It locates `gsd-tools.cjs` across every supported runtime home and defines a `gsd_run` function. If it cannot find the tool, it prints the standard install hint and exits non-zero.

```bash
```
</step>

<step name="detect">
**Detect the situation.**

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --default "" 2>/dev/null || echo "")
SNAPSHOT=$(gsd_run smart-entry --json 2>/dev/null)
```

**If `response_language` is set:** All user-facing questions, prompts, and explanations in this workflow MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

Parse `SNAPSHOT` as JSON. It has the shape:

```json
{
  "situation": "executing",
  "recommended": "progress-next",
  "summary": "Phase 2 of 5 · 60% · executing",
  "signals": { "...": "..." },
  "actions": [
    { "id": "progress-next", "label": "Advance to the next step", "command": "/gsd:progress --next", "recommended": true },
    { "id": "execute-phase", "label": "Continue executing phase 2", "command": "/gsd:execute-phase", "recommended": false }
  ]
}
```

`situation` is one of: `no-project`, `paused`, `blocked`, `verify-failed`, `needs-first-phase`, `planning`, `executing`, `verify-pending`, `idle-stranded`, `complete`, `unknown`.

**Fallback (never strand the user):** `smart-entry --json` can fail for two reasons, and each has a different recovery. Parse `SNAPSHOT`; if it is empty, not valid JSON, or missing `actions`, apply the first matching recovery below — do NOT error.

1. **`gsd-tools` itself is broken** (the failure is a `Cannot find module ...` / Node crash, not just an empty result). Probe by running `gsd_run state-snapshot` — if THAT also errors, the whole tool layer is down and routing to `/gsd:progress` would dead-end too (it also needs gsd-tools). **Recover by reading state directly:**
   - Read `.planning/STATE.md` (frontmatter + body) with the Read tool. Extract: `status` (frontmatter `status:` or body `**Status:**`), `Phase:` from the body, `total_phases`/`percent` from a nested `progress:` frontmatter object if present, and any `## Blockers` items.
   - Synthesize a minimal result: `situation` = your best guess from the status text (`executing`/`verifying`/`planning`/`complete`/`paused`), `summary` = a one-line read ("Phase N of M · status"), and an `actions` list built from status (e.g. verifying → `/gsd:verify-work`, executing → `/gsd:execute-phase`, else `/gsd:progress`), always including `/gsd:quick` and `/gsd:help`.
   - Print one line first: `smart-entry unavailable (gsd-tools error) — reading state directly. The gsd-tools layer may need a rebuild (rm tsconfig.build.tsbuildinfo && npm run build).`
   - Proceed to the `present` step with this synthesized result.

2. **Only `smart-entry` is unavailable** (e.g. older gsd-core without the subcommand; `state-snapshot` still works). Run `/gsd:progress` and stop. Print one line first: `smart-entry unavailable — showing progress.`
</step>

<step name="present">
**Present the menu.**

Show the `summary` line to orient the user, then offer the actions.

**If TEXT_MODE is false:** call `AskUserQuestion` with:
- `header`: a short label derived from `situation` (e.g. `executing` → "Continue work", `blocked` → "Unblock", `no-project` → "Get started", `complete` → "What next?").
- `question`: the `summary` line, then "What would you like to do?"
- `options`: the first 4 entries of `actions[]` in order. For each, `label` = the action's `label`, `description` = the action's `command`. The recommended action is already first; surface it as the first option. The user may also type a custom command (handled automatically).

**If TEXT_MODE is true:** print the `summary`, then a numbered list of ALL `actions[]` (not capped to 4 — text has no limit), then ask the user to type the number of their choice:

```
{summary}

  1. {actions[0].label}  ({actions[0].command})
  2. {actions[1].label}  ({actions[1].command})
  ...

Type a number, or describe what you want to do.
```

Wait for the user's response before continuing. Map the chosen number to the corresponding action.
</step>

<step name="display">
**Show the routing decision.**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► SMART ENTRY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Situation:** {situation}
**Routing to:** {chosen command}
```
</step>

<step name="dispatch">
**Dispatch and stop.**

Invoke the chosen action's `command`. If the user typed a free-form response instead of picking an action, treat it as freeform intent and route via `/gsd:progress --do "<their text>"`.

After invoking the command, **stop**. The dispatched command owns everything from here. Do not continue, do not chain, do not re-enter this workflow.
</step>

</process>

<success_criteria>
- [ ] Situation detected via `gsd_run smart-entry --json`
- [ ] Summary shown to orient the user
- [ ] Menu offered (AskUserQuestion, or numbered list under TEXT_MODE)
- [ ] Routing decision displayed before dispatch
- [ ] Exactly one command dispatched
- [ ] Any detection failure falls back to /gsd:progress (never strands the user)
- [ ] No work done directly — launcher only
</success_criteria>

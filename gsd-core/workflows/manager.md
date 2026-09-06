<purpose>

Interactive command center for managing a milestone from a single terminal. Shows a dashboard of all phases with visual status, dispatches discuss inline and runs plan/execute inline (backgrounded when dispatch-should-flatten returns false), and loops back to the dashboard after each action. Enables parallel phase work from one terminal.

</purpose>

<required_reading>

Read all files referenced by the invoking prompt's execution_context before starting.

</required_reading>

<process>

<step name="initialize" priority="first">

## 1. Initialize

Bootstrap via manager init:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(gsd_run query init.manager)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `milestone_version`, `milestone_name`, `phase_count`, `completed_count`, `in_progress_count`, `phases`, `recommended_actions`, `all_complete`, `waiting_signal`, `manager_flags`, `response_language`, and the optional trio `queued_milestone_version`, `queued_milestone_name`, `queued_phases` (added in SDK fix `2495-2496-2497` — may be absent on older SDK versions, treat missing as empty).

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated. Subagent dispatches (discuss/plan/execute) stay in English at the prompt level; include `response_language` in their spawn args per the workflow being dispatched.

`manager_flags` contains per-step passthrough flags from config:
- `manager_flags.discuss` — appended to `/gsd:discuss-phase` args (e.g. `"--auto --analyze"`)
- `manager_flags.plan` — appended to plan agent init command
- `manager_flags.execute` — appended to execute agent init command

These are empty strings by default. Set via: `gsd_run query config-set manager.flags.discuss "--auto --analyze"`

**If error:** Display the error message and exit.

Display startup banner:

```
### GSD ► MANAGER

 {milestone_version} — {milestone_name}
 {phase_count} phases · {completed_count} complete

 ✓ Discuss → inline    ◆ Plan/Execute → inline (background when FLATTEN=false)
 Dashboard auto-refreshes when background work is active.

---
```

Proceed to dashboard step.

</step>

<step name="dashboard">

## 2. Dashboard (Refresh Point)

**Every time this step is reached**, re-read state from disk to pick up changes from background agents:

```bash
INIT=$(gsd_run query init.manager)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse the full JSON. Build the dashboard display.

Build dashboard from JSON. Symbols: `✓` done, `◆` active, `○` pending, `·` queued. Progress bar: 20-char `█░`.

**Status mapping** (disk_status → D P E Status):

- `complete` → `✓ ✓ ✓` `✓ Complete`
- `executed` → `✓ ✓ ◆` `◆ Verification required`
- `partial` → `✓ ✓ ◆` `◆ Executing...`
- `planned` → `✓ ✓ ○` `○ Ready to execute`
- `discussed` → `✓ ○ ·` `○ Ready to plan`
- `researched` → `◆ · ·` `○ Ready to plan`
- `empty`/`no_directory` + `is_next_to_discuss` → `○ · ·` `○ Ready to discuss`
- `empty`/`no_directory` otherwise → `· · ·` `· Up next`
- If `is_active`, replace status icon with `◆` and append `(active)`

If any `is_active` phases, show: `◆ Background: {action} Phase {N}, ...` above grid.

Use `display_name` (not `name`) for the Phase column — it's pre-truncated to 20 chars with `…` if clipped. Pad all phase names to the same width for alignment.

Use `deps_display` from init JSON for the Deps column — shows which phases this phase depends on (e.g. `1,3`) or `—` for none.

Example output:

```
### GSD ► DASHBOARD
 ████████████░░░░░░░░ 60%  (3/5 phases)
 ◆ Background: Planning Phase 4
 | # | Phase                | Deps | D | P | E | Status              |
 |---|----------------------|------|---|---|---|---------------------|
 | 1 | Foundation           | —    | ✓ | ✓ | ✓ | ✓ Complete          |
 | 2 | API Layer            | 1    | ✓ | ✓ | ◆ | ◆ Executing (active)|
 | 3 | Auth System          | 1    | ✓ | ✓ | ○ | ○ Ready to execute  |
 | 4 | Dashboard UI & Set…  | 1,2  | ✓ | ◆ | · | ◆ Planning (active) |
 | 5 | Notifications        | —    | ○ | · | · | ○ Ready to discuss  |
 | 6 | Polish & Final Mail… | 1-5  | · | · | · | · Up next           |
```

**Queued section (next milestone preview):**

If `queued_phases` is present and non-empty, render a compact preview of the next milestone's phases directly below the main table. This surfaces upcoming work without cluttering the active-milestone grid. Skip this section entirely when `queued_phases` is empty or missing (e.g. the active milestone is the last one in the roadmap).

Use `queued_milestone_version` and `queued_milestone_name` for the header. Phases render without D/P/E columns since they aren't discussed yet — just number, name (pre-truncated `display_name`), dependencies (`deps_display`), and a fixed `· Queued` status. Phase-name padding should match the active-table column width for visual alignment.

Example:

```
### ◆ Queued — {queued_milestone_version} {queued_milestone_name}  ({queued_phases.length} phases)
 | # | Phase                | Deps | Status       |
 |---|----------------------|------|--------------|
 | 31| Email Logs           | —    | · Queued     |
 | 32| Today's Sheets       | 31   | · Queued     |
 | 33| Resend Backfill      | 31   | · Queued     |
 | 34| Business Day Audit   | 31   | · Queued     |
```

Queued phases are NOT eligible for the Continue action menu — they live in a future milestone and must wait for the current milestone to ship. The preview exists purely for situational awareness.

**Recommendations section:**

If `all_complete` is true:

```
### MILESTONE COMPLETE

All {phase_count} phases verified complete. Ready for final steps:
  → /gsd:verify-work — run acceptance testing
  → /gsd:complete-milestone — archive and wrap up
```

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
Ask user via AskUserQuestion:
- **question:** "All phases complete. What next?"
- **options:** "Verify work" / "Complete milestone" / "Exit manager"

Handle responses:
- "Verify work": `Skill(skill="gsd-verify-work")`  then loop to dashboard.
- "Complete milestone": `Skill(skill="gsd-complete-milestone")` then exit.
- "Exit manager": Go to exit step.

**If NOT all_complete**, build compound options from `recommended_actions`:

**Compound option logic:** Group background actions (plan/execute) together, and pair them with the single inline action (discuss) when one exists. The goal is to present the fewest options possible — one option can dispatch multiple background agents plus one inline action.

**Building options:**

1. Collect all background actions (execute and plan recommendations) — there can be multiple of each.
2. Collect verification actions (`verify`) for implementation-complete phases whose canonical verification has not passed.
3. Collect the inline action (discuss recommendation, if any — there will be at most one since discuss is sequential).
4. Build compound options:

   **If there are ANY recommended actions (background, inline, or both):**
   Create ONE primary "Continue" option that dispatches ALL of them together:
   - Label: `"Continue"` — always this exact word
   - Below the label, list every action that will happen. Enumerate ALL recommended actions — do not cap or truncate:
     ```
     Continue:
       → Execute Phase 32 (background)
       → Plan Phase 34 (background)
       → Verify Phase 33
       → Discuss Phase 35 (inline)
     ```
   - This dispatches all background agents first, runs verification actions inline, then runs the inline discuss (if any).
   - If there is no inline discuss, the dashboard refreshes after spawning background agents and inline verification.

   **Important:** The Continue option must include EVERY action from `recommended_actions` — not just 2. If there are 3 actions, list 3. If there are 5, list 5.

4. Always add:
   - `"Refresh dashboard"`
   - `"Exit manager"`

Display recommendations compactly:

```
### ▶ Next Steps

Continue:
  → Execute Phase 32 (background)
  → Plan Phase 34 (background)
  → Discuss Phase 35 (inline)
```

**Auto-refresh:** If background agents are running (`is_active` is true for any phase), set a 60-second auto-refresh cycle. After presenting the action menu, if no user input is received within 60 seconds, automatically refresh the dashboard. This interval is configurable via `manager_refresh_interval` in GSD config (default: 60 seconds, set to 0 to disable).

Present via AskUserQuestion:
- **question:** "What would you like to do?"
- **options:** (compound options as built above + refresh + exit, AskUserQuestion auto-adds "Other")

**On "Other" (free text):** Parse intent — if it mentions a phase number and action, dispatch accordingly. If unclear, display available actions and loop to action_menu.

Proceed to handle_action step with the selected action.

</step>

<step name="handle_action">

## 4. Handle Action

### Refresh Dashboard

Loop back to dashboard step.

### Exit Manager

Go to exit step.

### Compound Action (background + inline)

When the user selects a compound option, behavior depends on whether the runtime supports background dispatch of nesting-capable orchestrators — the Plan Phase N / Execute Phase N handlers below resolve it via `gsd_run query dispatch-should-flatten` (#1708):

- **If `FLATTEN` is `false` (the host can background a nesting-capable orchestrator — e.g. codex, cursor):** **Spawn all background agents first** (plan/execute) — dispatch them in parallel using the Plan Phase N / Execute Phase N handlers below — then run verification actions, then run the inline discuss; the background agents continue while you verify/discuss.
- **Otherwise (`FLATTEN` is `true` — run inline):** run the chosen plan/execute step(s) **inline** via their handlers below (in order), then run verification actions, then run the inline discuss. There is no overlap.

Inline verification:

For each verification recommendation, dispatch by the recommended action's `command`:
- If `command` contains `execute-phase`, run `Skill(skill="gsd-execute-phase", args="{PHASE_NUM} {manager_flags.execute}")`.
- If `command` contains `verify-work`, run `Skill(skill="gsd-verify-work", args="{PHASE_NUM}")`.
- If `command` is missing or unrecognized, stop and show the recommendation row instead of guessing.

Inline discuss:

```
Skill(skill="gsd-discuss-phase", args="{PHASE_NUM} {manager_flags.discuss}")
```

After discuss completes, loop back to dashboard step.

### Discuss Phase N

Discussion is interactive — needs user input. Run inline with any configured flags:

```
Skill(skill="gsd-discuss-phase", args="{PHASE_NUM} {manager_flags.discuss}")
```

After discuss completes, loop back to dashboard step.

### Plan Phase N

Planning runs autonomously. **First resolve whether background dispatch is safe.** Background dispatch is only safe on a runtime where a backgrounded agent can still nest the pipeline's subagents (plan-checker / worktree executors / verifier). This is determined from the documentation-sourced dispatch capability in the registry (#1708); Claude Code's backgrounded agents have no `Agent`/`Task` tool, and every other runtime either prohibits nested subagents or disables them by default. So run **inline** everywhere except where `dispatch-should-flatten` returns `false`.

```bash
FLATTEN=$(gsd_run query dispatch-should-flatten --raw 2>/dev/null || echo "true")
```

**If `FLATTEN` is `false`:** Spawn a background agent that delegates to the Skill pipeline with any configured flags:

```
Agent(
  description="Plan phase {N}: {phase_name}",
  run_in_background=true,
  prompt="You are running the GSD plan-phase workflow for phase {N} of the project.

Working directory: {cwd}
Phase: {N} — {phase_name}
Goal: {goal}
Manager flags: {manager_flags.plan}

Run the plan-phase Skill with any configured manager flags:
Skill(skill=\"gsd-plan-phase\", args=\"{N} --auto {manager_flags.plan}\")

This delegates to the full plan-phase pipeline including local patches, research, plan-checker, and all quality gates.

Important: You are running in the background. Do NOT use AskUserQuestion — make autonomous decisions based on project context. If you hit a blocker, write it to STATE.md as a blocker and stop. Do NOT silently work around permission or file access errors — let them fail so the manager can surface them with resolution hints. Do NOT use --no-verify on git commits."
)
```

> **ORCHESTRATOR RULE — BACKGROUND DISPATCH**: After calling Agent() above with `run_in_background=true`, do NOT do any planning work for this phase independently. Return to the dashboard immediately and wait for the background agent to report back. Only resume planning-related work when the subagent result is available. Never call `ScheduleWakeup` or any host wake/sleep-scheduling tool while waiting (#4079) — a partial-args wake call surfaces a red validation error; the dashboard loop is the wait.

Display:

```
◆ Spawning planner for Phase {N}: {phase_name}... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Loop back to dashboard step.

**Otherwise (`FLATTEN` is `true` — run inline):** Run plan inline so the plan-checker and quality gates actually run — do NOT wrap it in `Agent(run_in_background=true, …)`:

```
Skill(skill="gsd-plan-phase", args="{N} --auto {manager_flags.plan}")
```

Display while it runs:

```
◆ Planning Phase {N}: {phase_name}... (runs inline so the plan-checker runs — the dashboard resumes when it returns, ~1–5 min; expected, not a freeze)
```

Then loop back to dashboard step.

### Execute Phase N

Execution runs autonomously. **First resolve whether background dispatch is safe.** Background dispatch is only safe on a runtime where a backgrounded agent can still nest the pipeline's subagents (plan-checker / worktree executors / verifier). This is determined from the documentation-sourced dispatch capability in the registry (#1708); Claude Code's backgrounded agents have no `Agent`/`Task` tool, and every other runtime either prohibits nested subagents or disables them by default. So run **inline** everywhere except where `dispatch-should-flatten` returns `false`.

```bash
FLATTEN=$(gsd_run query dispatch-should-flatten --raw 2>/dev/null || echo "true")
```

**If `FLATTEN` is `false`:** Spawn a background agent that delegates to the Skill pipeline with any configured flags:

```
Agent(
  description="Execute phase {N}: {phase_name}",
  run_in_background=true,
  prompt="You are running the GSD execute-phase workflow for phase {N} of the project.

Working directory: {cwd}
Phase: {N} — {phase_name}
Goal: {goal}
Manager flags: {manager_flags.execute}

Run the execute-phase Skill with any configured manager flags:
Skill(skill=\"gsd-execute-phase\", args=\"{N} {manager_flags.execute}\")

This delegates to the full execute-phase pipeline including local patches, branching, wave-based execution, verification, and all quality gates.

Important: You are running in the background. Do NOT use AskUserQuestion — make autonomous decisions. Do NOT use --no-verify on git commits — let pre-commit hooks run normally. If you hit a permission error, file lock, or any access issue, do NOT work around it — let it fail and write the error to STATE.md as a blocker so the manager can surface it with resolution guidance."
)
```

> **ORCHESTRATOR RULE — BACKGROUND DISPATCH**: After calling Agent() above with `run_in_background=true`, do NOT do any execution work for this phase independently. Return to the dashboard immediately and wait for the background agent to report back. Only resume execution-related work when the subagent result is available. Never call `ScheduleWakeup` or any host wake/sleep-scheduling tool while waiting (#4079) — a partial-args wake call surfaces a red validation error; the dashboard loop is the wait.

Display:

```
◆ Spawning executor for Phase {N}: {phase_name}... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Loop back to dashboard step.

**Otherwise (`FLATTEN` is `true` — run inline):** Run execute inline so worktree isolation and the verifier actually run — do NOT wrap it in `Agent(run_in_background=true, …)`:

```
Skill(skill="gsd-execute-phase", args="{N} {manager_flags.execute}")
```

Display while it runs:

```
◆ Executing Phase {N}: {phase_name}... (runs inline so worktree isolation and verification run — the dashboard resumes when it returns; expected, not a freeze)
```

Then loop back to dashboard step.

</step>

<step name="background_completion">

## 5. Background Agent Completion

When notified that a background agent completed:

1. Read the result message from the agent.
2. Display a brief notification:

```
✓ {description}
  {brief summary from agent result}
```

3. Loop back to dashboard step.

**If the agent reported an error or blocker:**

Classify the error:

**Permission / tool access error** (e.g. tool not allowed, permission denied, sandbox restriction):
- Parse the error to identify which tool or command was blocked.
- Display the error clearly, then offer to fix it:
  - **question:** "Phase {N} failed — permission denied for `{tool_or_command}`. Want me to add it to settings.local.json so it's allowed?"
  - **options:** "Add permission and retry" / "Run this phase inline instead" / "Skip and continue"
  - "Add permission and retry": Use `Skill(skill="update-config")` to add the permission to `settings.local.json`, then re-spawn the background agent. Loop to dashboard.
  - "Run this phase inline instead": Dispatch the same action inline via the appropriate Skill — use `Skill(skill="gsd-plan-phase", args="{N}")` if the failed action was planning, or `Skill(skill="gsd-execute-phase", args="{N}")` if the failed action was execution. Loop to dashboard after.
  - "Skip and continue": Loop to dashboard (phase stays in current state).

**Other errors** (git lock, file conflict, logic error, etc.):
- Display the error, then offer options via AskUserQuestion:
  - **question:** "Background agent for Phase {N} encountered an issue: {error}. What next?"
  - **options:** "Retry" / "Run inline instead" / "Skip and continue" / "View details"
  - "Retry": Re-spawn the same background agent. Loop to dashboard.
  - "Run inline instead": Dispatch the action inline via the appropriate Skill — use `Skill(skill="gsd-plan-phase", args="{N}")` if the failed action was planning, or `Skill(skill="gsd-execute-phase", args="{N}")` if the failed action was execution. Loop to dashboard after.
  - "Skip and continue": Loop to dashboard (phase stays in current state).
  - "View details": Read STATE.md blockers section, display, then re-present options.

</step>

<step name="exit">

## 6. Exit

Display final status with progress bar:

```
### GSD ► SESSION END

 {milestone_version} — {milestone_name}
 {PROGRESS_BAR} {progress_pct}%  ({completed_count}/{phase_count} phases)

 Resume anytime: /gsd:manager

---
```

**Note:** Any background agents still running will continue to completion. Their results will be visible on next `/gsd:manager` or `/gsd:progress` invocation.

</step>

</process>

<success_criteria>
- [ ] Dashboard displays all phases with correct status indicators (D/P/E/V columns)
- [ ] Progress bar shows accurate completion percentage
- [ ] Dependency resolution: blocked phases show which deps are missing
- [ ] Recommendations prioritize: execute > plan > discuss
- [ ] Discuss phases run inline via Skill() — interactive questions work
- [ ] Plan phases run inline (or as background Task agents on Codex) — dashboard resumes when complete
- [ ] Execute phases run inline (or as background Task agents on Codex) — dashboard resumes when complete
- [ ] Dashboard refreshes pick up changes from background agents via disk state
- [ ] Background agent completion triggers notification and dashboard refresh
- [ ] Background agent errors present retry/skip options
- [ ] All-complete state offers verify-work and complete-milestone
- [ ] Exit shows final status with resume instructions
- [ ] "Other" free-text input parsed for phase number and action
- [ ] Manager loop continues until user exits or milestone completes
- [ ] Queued section renders when `queued_phases` is non-empty; skipped when absent or empty
</success_criteria>

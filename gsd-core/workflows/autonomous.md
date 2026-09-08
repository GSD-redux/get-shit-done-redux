@~/.claude/gsd-core/references/response-language-directive.md

<purpose>

Drive milestone phases autonomously — all remaining phases, a range via `--from N`/`--to N`, or a single phase via `--only N`. For each incomplete phase: discuss → plan → execute using Skill() flat invocations. When `--converge` or `--cross-ai` is set, route the planning step through plan-review convergence before execution. Pauses only for explicit user decisions (grey area acceptance, blockers, validation requests). Re-reads ROADMAP.md after each phase to catch dynamically inserted phases.

</purpose>

<required_reading>

Read all files referenced by the invoking prompt's execution_context before starting.

</required_reading>

<process>

<step name="initialize" priority="first">

## 1. Initialize

Parse `$ARGUMENTS` for `--from N`, `--to N`, `--only N`, `--interactive`, `--converge`/`--cross-ai`, reviewer selector flags, and `--max-cycles N`:

```bash
FROM_PHASE=""
if echo "$ARGUMENTS" | grep -qE '\-\-from\s+[0-9]'; then
  FROM_PHASE=$(echo "$ARGUMENTS" | grep -oE '\-\-from\s+[0-9]+\.?[0-9]*' | awk '{print $2}')
fi

TO_PHASE=""
if echo "$ARGUMENTS" | grep -qE '\-\-to\s+[0-9]'; then
  TO_PHASE=$(echo "$ARGUMENTS" | grep -oE '\-\-to\s+[0-9]+\.?[0-9]*' | awk '{print $2}')
fi

ONLY_PHASE=""
if echo "$ARGUMENTS" | grep -qE '\-\-only\s+[0-9]'; then
  ONLY_PHASE=$(echo "$ARGUMENTS" | grep -oE '\-\-only\s+[0-9]+\.?[0-9]*' | awk '{print $2}')
  FROM_PHASE="$ONLY_PHASE"
fi

INTERACTIVE=""
if echo "$ARGUMENTS" | grep -q '\-\-interactive'; then
  INTERACTIVE="true"
fi

PLAN_STRATEGY="local"
if echo "$ARGUMENTS" | grep -qE '(^|[[:space:]])\-\-(converge|cross-ai)([[:space:]]|$)'; then
  PLAN_STRATEGY="converge"
fi

CONVERGE_PARAM=""
if echo "$ARGUMENTS" | grep -qE '(^|[[:space:]])\-\-converge([[:space:]]|$)'; then
  CONVERGE_PARAM="--converge"
fi
CROSS_AI_PARAM=""
if echo "$ARGUMENTS" | grep -qE '(^|[[:space:]])\-\-cross-ai([[:space:]]|$)'; then
  CROSS_AI_PARAM="--cross-ai"
fi
```

When `--only` is set, also set `FROM_PHASE` to the same value so existing filter logic applies.

When `--interactive` is set, discuss stays inline. If `dispatch-should-flatten` returns `false`, dispatch plan and execute as background agents; if it returns `true`, run them inline and keep phases sequential. Preserve user input on all design decisions.

When `PLAN_STRATEGY=converge`, the planning step MUST invoke the plan-review convergence workflow instead of `gsd-plan-phase`. `--cross-ai` is an alias for `--converge`. Forward `CONVERGENCE_ARGS` exactly as parsed so reviewer flags and `--max-cycles N` retain the same meaning as they have on `/gsd:plan-review-convergence`.

Bootstrap via milestone-level init:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(gsd_run query init.milestone-op)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
INIT_AUTONOMOUS=$(gsd_run query init.autonomous $CONVERGE_PARAM $CROSS_AI_PARAM)
if [[ "$INIT_AUTONOMOUS" == @file:* ]]; then INIT_AUTONOMOUS=$(cat "${INIT_AUTONOMOUS#@file:}"); fi
```

Extract `section_manifest` from `INIT_AUTONOMOUS` (used by the `converge-*` sections below and in step 3).

If `PLAN_STRATEGY` is `converge`, fail fast unless the existing convergence feature gate is enabled:

```bash
# Lane flags derived from the declared roster (#2800/#2272); --all and --text are convergence
# controls, not reviewer lanes, so they stay literal.
# This block must stay AFTER the launcher preamble (above) because it calls `gsd_run` —
# do not move it back above the preamble in a future edit.
CONVERGENCE_ARGS=""
for REVIEW_FLAG in $(gsd_run review-lane flags) --all --text; do
  if echo "$ARGUMENTS" | grep -qE "(^|[[:space:]])${REVIEW_FLAG}([[:space:]]|$)"; then
    CONVERGENCE_ARGS="${CONVERGENCE_ARGS} ${REVIEW_FLAG}"
  fi
done

MAX_CYCLES_ARG=""
if echo "$ARGUMENTS" | grep -qE '\-\-max-cycles\s+[0-9]+'; then
  MAX_CYCLES_ARG=$(echo "$ARGUMENTS" | grep -oE '\-\-max-cycles\s+[0-9]+' | awk '{print $2}')
  CONVERGENCE_ARGS="${CONVERGENCE_ARGS} --max-cycles ${MAX_CYCLES_ARG}"
fi
```

<!-- gsd:section id="converge-fail-fast" when="state:plan-strategy-converge" -->
If `section_manifest` is `null` or `"converge-fail-fast"` is in its `included` list: read and execute `gsd-core/workflows/autonomous/steps/converge-fail-fast.md`. Otherwise skip — do not read the file.
<!-- /gsd:section -->

Parse JSON for: `milestone_version`, `milestone_name`, `phase_count`, `completed_phases`, `roadmap_exists`, `state_exists`, `commit_docs`.

**If `roadmap_exists` is false:** Error — "No ROADMAP.md found. Run `/gsd:new-milestone` first."
**If `state_exists` is false:** Error — "No STATE.md found. Run `/gsd:new-milestone` first."

Display startup banner:

```
### GSD ► AUTONOMOUS

 Milestone: {milestone_version} — {milestone_name}
 Phases: {phase_count} total, {completed_phases} complete
```

If `ONLY_PHASE` is set, display: `Single phase mode: Phase ${ONLY_PHASE}`
Else if `FROM_PHASE` is set, display: `Starting from phase ${FROM_PHASE}`
If `TO_PHASE` is set, display: `Stopping after phase ${TO_PHASE}`
If `INTERACTIVE` is set, display: `Mode: Interactive (discuss inline, plan+execute inline — background on Codex only)`
<!-- gsd:section id="converge-banner" when="state:plan-strategy-converge" -->
If `section_manifest` is `null` or `"converge-banner"` is in its `included` list: read and execute `gsd-core/workflows/autonomous/steps/converge-banner.md`. Otherwise skip — do not read the file.
<!-- /gsd:section -->

**Agent skills (delegated agents self-load):** This workflow delegates plan/execute/review via flat `Skill()` invocations rather than resolving `agent_skills` itself. Each consumer agent (`gsd-planner`, `gsd-executor`, `gsd-plan-checker`, `gsd-verifier`, …) self-loads its configured `.planning/config.json` `agent_skills` in its own mandatory init step per `@~/.claude/gsd-core/references/agent-skills-bootstrap.md`. This is the durable path that works on every runtime — including Cursor, where `Skill()`-delegated workflow bash init does not reliably execute. No per-delegation injection is needed here. See open-gsd/gsd-core#1866.

</step>

<step name="discover_phases">

## 2. Discover Phases

Run phase discovery:

```bash
INIT_MANAGER=$(gsd_run query init.manager)
if [[ "$INIT_MANAGER" == @file:* ]]; then INIT_MANAGER=$(cat "${INIT_MANAGER#@file:}"); fi
STATE_CONTENT=$(cat .planning/STATE.md 2>/dev/null || true)
```

Parse the JSON `phases` array.

Parse the optional `## Deferred Verification` table from `STATE_CONTENT` into a phase-number map:
- `verification_deferred_human` -> `/gsd:verify-work <phase>`
- `verification_deferred_gaps` -> `/gsd:plan-phase <phase> --gaps`

**Skip deferred phases on autonomous re-entry:** drop any phase whose number appears in the deferred-phase map from this run's queue; resume it only through the recorded command.

**Filter to incomplete phases:** Keep `phase_complete !== true`, including implemented phases with `verification_status !== "passed"`.

**Apply `--from N`:** If set, filter out phases where `number < FROM_PHASE` (numeric compare; handles "5.1").

**Apply `--to N`:** If set, filter out phases where `number > TO_PHASE` (numeric compare).

**Apply `--only N`:** If set, filter out phases where `number != ONLY_PHASE`.

**If `TO_PHASE` is set and no phases remain** (all phases up to N are already completed):

```
All phases through ${TO_PHASE} are already completed. Nothing to do.
```

Exit cleanly.

**If `ONLY_PHASE` is set and no phases remain** (phase already complete):

```
Phase ${ONLY_PHASE} is already complete. Nothing to do.
```

Exit cleanly.

**Sort by `number`** in numeric ascending order.

**If no incomplete phases remain:**

```
### GSD ► AUTONOMOUS ▸ COMPLETE 🎉

 All phases complete! Nothing left to do.
```

Exit cleanly.

**Display phase plan:**

```
## Phase Plan

| # | Phase | Status |
|---|-------|--------|
| 5 | Skill Scaffolding & Phase Discovery | In Progress |
| 6 | Smart Discuss | Not Started |
| 7 | Auto-Chain Refinements | Not Started |
| 8 | Lifecycle Orchestration | Not Started |
```

**If any deferred phases were skipped:** display `## Deferred Verification (Skipped on Re-entry)` with the skipped rows and resume commands, then omit them from this run's queue.

**Fetch details for each phase:**

```bash
DETAIL=$(gsd_run query roadmap.get-phase ${PHASE_NUM})
```

Extract `phase_name`, `goal`, `success_criteria` from each. Store for use in execute_phase and transition messages.

</step>

<step name="execute_phase">

## 3. Execute Phase

For the current phase, display the progress banner:

```
### GSD ► AUTONOMOUS ▸ Phase {N}/{T}: {Name} [████░░░░] {P}%
```

Where N is the ROADMAP phase number, T is the milestone `phase_count`, and P = completed milestone phases / T × 100. Use `phase_count`, not remaining phases: phase 63 in a 7-phase milestone is `Phase 63/7`, not `Phase 63/3`. If N > T, render `Phase {N} ({position}/{T})`. Use an 8-character bar with █ and ░.

**3a. Smart Discuss**

Check if CONTEXT.md already exists for this phase:

```bash
PHASE_STATE=$(gsd_run query init.phase-op ${PHASE_NUM})
```

Parse `has_context` from JSON.

**If has_context is true:** Skip discuss — context already gathered. Display:

```
Phase ${PHASE_NUM}: Context exists — skipping discuss.
```

Proceed to 3b.

**If has_context is false:** Check if discuss is disabled via settings:

```bash
SKIP_DISCUSS=$(gsd_run query config-get workflow.skip_discuss --raw 2>/dev/null || echo "false")
```

**If SKIP_DISCUSS is `true`:** Skip discuss entirely — the ROADMAP phase description is the spec. Display:

```
Phase ${PHASE_NUM}: Discuss skipped (workflow.skip_discuss=true) — using ROADMAP phase goal as spec.
```

Write a minimal CONTEXT.md so downstream plan-phase has valid input. Get phase details:

```bash
DETAIL=$(gsd_run query roadmap.get-phase ${PHASE_NUM})
```

Extract `goal` and `requirements` from JSON. Write `${phase_dir}/${padded_phase}-CONTEXT.md` with:

```markdown
# Phase {PHASE_NUM}: {Phase Name} - Context

**Gathered:** {date}
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss)

<domain>
## Phase Boundary

{goal from ROADMAP phase description}

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — discuss phase was skipped per user setting. Use ROADMAP phase goal, success criteria, and codebase conventions to guide decisions.

</decisions>

<code_context>
## Existing Code Insights

Codebase context will be gathered during plan-phase research.

</code_context>

<specifics>
## Specific Ideas

No specific requirements — discuss phase skipped. Refer to ROADMAP phase description and success criteria.

</specifics>

<deferred>
## Deferred Ideas

None — discuss phase skipped.

</deferred>
```

Commit the minimal context:

```bash
gsd_run query commit "docs(${PADDED_PHASE}): auto-generated context (discuss skipped)" --files "${phase_dir}/${padded_phase}-CONTEXT.md"
```

Proceed to 3b.

**If SKIP_DISCUSS is `false` (or unset):**

**IMPORTANT — Discuss must be single-pass in autonomous mode.**
The discuss step in `--auto` mode MUST NOT loop. If CONTEXT.md already exists after discuss completes, do NOT re-invoke discuss for the same phase. The `has_context` check below is authoritative — once true, discuss is done for this phase regardless of perceived "gaps" in the context file.

**If `INTERACTIVE` is set:** Run the standard discuss-phase skill inline (asks interactive questions, waits for user answers). This preserves user input on all design decisions while keeping plan+execute out of the main context:

```
Skill(skill="gsd-discuss-phase", args="${PHASE_NUM}")
```

**If `INTERACTIVE` is NOT set:** Execute the smart_discuss step for this phase (batch table proposals, auto-optimized).

After discuss completes (either mode), verify context was written:

```bash
PHASE_STATE=$(gsd_run query init.phase-op ${PHASE_NUM})
```

Check `has_context`. If false → go to handle_blocker: "Discuss for phase ${PHASE_NUM} did not produce CONTEXT.md."

**3a.5. UI Design Contract (Frontend Phases)**

> Full instructions are in `gsd-core/references/autonomous-ui-design-contract.md`. Read that file now and follow it exactly.

**Inputs:** `PHASE_NUM`, `PHASE_DIR` from execute_phase. Resolves whether the phase needs a UI-SPEC.md generated before planning via active `plan:pre` step hooks. Always non-blocking — proceeds to 3b regardless of outcome.

Read and execute: `$HOME/.claude/gsd-core/references/autonomous-ui-design-contract.md`

**3b. Plan**

**If `INTERACTIVE` is set:** Background dispatch is only safe on a runtime where a backgrounded agent can still nest the pipeline's subagents (plan-checker / worktree executors / verifier). This is determined from the documentation-sourced dispatch capability in the registry (#1708); Claude Code's backgrounded agents have no `Agent`/`Task` tool, and every other runtime either prohibits nested subagents or disables them by default. So run **inline** everywhere except where `dispatch-should-flatten` returns `false`. Resolve first:

```bash
FLATTEN=$(gsd_run query dispatch-should-flatten --raw 2>/dev/null || echo "true")
```

- **If `FLATTEN` is `false`:** Dispatch plan as a background agent to keep the main context lean. While plan runs, the workflow can immediately start discussing the next phase (see step 4).

  <!-- gsd:section id="converge-dispatch-bg" when="state:plan-strategy-converge" -->
  If `section_manifest` is `null` or `"converge-dispatch-bg"` is in its `included` list: read and execute `gsd-core/workflows/autonomous/steps/converge-dispatch-bg.md`. Otherwise skip — do not read the file.
  <!-- /gsd:section -->

  - Otherwise, print: `◆ Spawning background planner for phase ${PHASE_NUM}... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)`

  ```
  Agent(
    description="Plan phase ${PHASE_NUM}: ${PHASE_NAME}",
    run_in_background=true,
    prompt="Run plan-phase for phase ${PHASE_NUM}: Skill(skill=\"gsd-plan-phase\", args=\"${PHASE_NUM}\")"
  )
  ```

  Store the agent task_id. After discuss for the next phase completes (or if no next phase), wait for the plan agent to finish before proceeding to execute.

- **Otherwise (`FLATTEN` is `true` — run inline):** Run plan **inline** (do NOT background) so the plan-checker runs. The next phase's discuss does not overlap planning here — correctness over overlap.

  <!-- gsd:section id="converge-dispatch-inline" when="state:plan-strategy-converge" -->
  If `section_manifest` is `null` or `"converge-dispatch-inline"` is in its `included` list: read and execute `gsd-core/workflows/autonomous/steps/converge-dispatch-inline.md`. Otherwise skip — do not read the file.
  <!-- /gsd:section -->

  - Otherwise (local planning):

  ```
  Skill(skill="gsd-plan-phase", args="${PHASE_NUM}")
  ```

**If `INTERACTIVE` is NOT set (default):** Run plan inline.

<!-- gsd:section id="converge-loop" when="state:plan-strategy-converge" -->
If `section_manifest` is `null` or `"converge-loop"` is in its `included` list: read and execute `gsd-core/workflows/autonomous/steps/converge-loop.md`. Otherwise skip — do not read the file.
<!-- /gsd:section -->

If `PLAN_STRATEGY=local`, run the regular planner:

```
Skill(skill="gsd-plan-phase", args="${PHASE_NUM}")
```

Verify plan produced output — re-run `init phase-op` and check `has_plans`. If false → go to handle_blocker: "Plan phase ${PHASE_NUM} did not produce any plans."

**3c. Execute**

**If `INTERACTIVE` is set:** Wait for the plan agent to complete (if not already) and verify plans exist. Background dispatch is only safe on a runtime where a backgrounded agent can still nest the pipeline's subagents (plan-checker / worktree executors / verifier). This is determined from the documentation-sourced dispatch capability in the registry (#1708); Claude Code's backgrounded agents have no `Agent`/`Task` tool, and every other runtime either prohibits nested subagents or disables them by default. So run **inline** everywhere except where `dispatch-should-flatten` returns `false`. Resolve first:

```bash
FLATTEN=$(gsd_run query dispatch-should-flatten --raw 2>/dev/null || echo "true")
```

- **If `FLATTEN` is `false`:** Dispatch execute as a background agent:

```
Agent(
  description="Execute phase ${PHASE_NUM}: ${PHASE_NAME}",
  run_in_background=true,
  prompt="Run execute-phase for phase ${PHASE_NUM}: Skill(skill=\"gsd-execute-phase\", args=\"${PHASE_NUM} --no-transition\")"
)
```

  Store the agent task_id. The workflow can now start discussing the next phase while this phase executes in the background. Before starting post-execution routing for this phase, wait for the execute agent to complete.

- **Otherwise (`FLATTEN` is `true` — run inline):** Run execute **inline** (do NOT background) so worktree isolation and verification run:

```
Skill(skill="gsd-execute-phase", args="${PHASE_NUM} --no-transition")
```

**If `INTERACTIVE` is NOT set (default):** Run execute inline as before.

```
Skill(skill="gsd-execute-phase", args="${PHASE_NUM} --no-transition")
```

**3c.5. Code Review and Fix**

Auto-invoke code review and fix chain. Autonomous mode chains both review and fix (unlike execute-phase/quick which only suggest fix).

**Capability dispatch:**
```bash
EXECUTE_POST_HOOKS_JSON=$(gsd_run loop render-hooks execute:post --raw)
```

Resolve active step hooks from `EXECUTE_POST_HOOKS_JSON` where `kind == "step"` and `ref.skill == "code-review"`.

If no active code-review step hook exists: display "Code review skipped (code-review capability inactive)" and proceed to 3d. This covers `workflow.code_review=false` through the Capability Registry; do not query the code-review toggle directly here.

For each active code-review step hook, dispatch the skill using the registry-provided stem:

```
Skill(skill="gsd-${ref.skill}", args="${PHASE_NUM}")
```

Parse status from REVIEW.md frontmatter. If "clean" or "skipped": proceed to 3d. If findings found after the capability-dispatched review, auto-invoke the consolidated fix entry point:
```
Skill(skill="gsd-code-review", args="${PHASE_NUM} --fix --auto")
```

**Error handling:** If either Skill fails, catch the error, display as non-blocking, and proceed to 3d.

**3d. Post-Execution Routing**

After execute, read canonical verification:

```bash
VERIFY_STATUS=$(gsd_run query verification.status "${PHASE_DIR}" --pick status 2>/dev/null || true)
```

If `PHASE_DIR` is absent, re-fetch `init.phase-op ${PHASE_NUM}` and parse `phase_dir`.

If `VERIFY_STATUS` is empty, handle_blocker: "No verification results for phase ${PHASE_NUM}."

**If `passed`:**

Display `Phase ${PHASE_NUM} ✅ ${PHASE_NAME} — Verification passed`, run `@~/.claude/gsd-core/workflows/transition.md`, then Proceed to iterate step.

**If `stale`:** handle_blocker: "Stale verification for phase ${PHASE_NUM}."

**If `human_needed`:**

Read `human_verification` items. In text mode (`--text` or init `text_mode=true`), replace AskUserQuestion with a plain-text numbered list. Otherwise ask whether to validate now or continue without validation. If validating now, present items, then ask `Validation result?` with `All good — continue` / `Found issues`.

On "All good — continue": set VERIFICATION frontmatter `status: passed`, display `Phase ${PHASE_NUM} ✅ Human validation passed`, run `@~/.claude/gsd-core/workflows/transition.md`, then iterate.

On "Found issues": Go to handle_blocker with the user's reported issues as the description.

On **"Continue without validation"**: record an explicit deferred state and stop autonomous mode:

```markdown
## Deferred Verification

| Phase | State | Resume |
|-------|-------|--------|
| ${PHASE_NUM} | verification_deferred_human | /gsd:verify-work ${PHASE_NUM} |
```

Append/update this STATE.md section, display `Phase ${PHASE_NUM} ⏭ verification_deferred_human — resume with /gsd:verify-work ${PHASE_NUM}`, then handle_blocker: "Human verification deferred for phase ${PHASE_NUM}."

**If `gaps_found`:**

Read gap score/items from VERIFICATION.md. Display:
```
⚠ Phase ${PHASE_NUM}: ${PHASE_NAME} — Gaps Found
Score: {N}/{M} must-haves verified
```

Ask how to proceed: `Run gap closure` / `Continue without fixing` / `Stop autonomous mode`.

On **"Run gap closure"**: one gap-closure attempt:

```
Skill(skill="gsd-plan-phase", args="${PHASE_NUM} --gaps")
```

Re-run `init phase-op ${PHASE_NUM}`; if `has_plans` is false, handle_blocker: "Gap closure planning for phase ${PHASE_NUM} did not produce plans."

Re-execute:
```
Skill(skill="gsd-execute-phase", args="${PHASE_NUM} --no-transition")
```

Re-read verification status:
```bash
VERIFY_STATUS=$(gsd_run query verification.status "${PHASE_DIR}" --pick status 2>/dev/null || true)
```

If `passed` or `human_needed`: route normally.

If `stale`: handle_blocker: "Stale verification for phase ${PHASE_NUM}."

If still `gaps_found` after this retry, display `Gaps persist after closure attempt.` and ask `Continue anyway` / `Stop autonomous mode`.

On "Continue anyway": record `verification_deferred_gaps` using the table below, display `Phase ${PHASE_NUM} ⏭ verification_deferred_gaps — resume with /gsd:plan-phase ${PHASE_NUM} --gaps`, then handle_blocker: "Verification gaps deferred for phase ${PHASE_NUM}."
On "Stop autonomous mode": Go to handle_blocker.

This limits gap closure to 1 retry.

On **"Continue without fixing"**: record an explicit deferred state and stop autonomous mode:

```markdown
## Deferred Verification

| Phase | State | Resume |
|-------|-------|--------|
| ${PHASE_NUM} | verification_deferred_gaps | /gsd:plan-phase ${PHASE_NUM} --gaps |
```

Append/update this STATE.md section, display `Phase ${PHASE_NUM} ⏭ verification_deferred_gaps — resume with /gsd:plan-phase ${PHASE_NUM} --gaps`, then handle_blocker: "Verification gaps deferred for phase ${PHASE_NUM}."

On **"Stop autonomous mode"**: Go to handle_blocker with "User stopped — gaps remain in phase ${PHASE_NUM}".

**3d.5. UI Review (Frontend Phases)**

> Run only after `passed` or human verification was updated to `passed`.

Resolve the active post-verification hooks and the UI-SPEC gate:

```bash
UI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-UI-SPEC.md 2>/dev/null | head -1)
HOOKS_JSON=$(gsd_run loop render-hooks verify:post --raw)
```

Read the `activeHooks` array directly from the `HOOKS_JSON` value already in context (do not invoke a shell `jq` pipeline — parse as the JSON object it is). **If `activeHooks` is empty or absent:** skip silently to the iterate step.

For each entry in `activeHooks` in array order where `kind == "step"` and `ref.skill` is set:

- **Honor `consumes`:** if the hook's `consumes` array includes `"UI-SPEC.md"` and `UI_SPEC_FILE` is empty (no `*-UI-SPEC.md` exists in `PHASE_DIR`) → skip that hook (`onError: skip`). Hooks that do not declare `"UI-SPEC.md"` in their `consumes` proceed normally regardless of `UI_SPEC_FILE`.
- Invoke:

```
Skill(skill="gsd-${ref.skill}", args="${PHASE_NUM}")
```

(i.e. prepend `gsd-` to `ref.skill` — so `ui-review` → `gsd-ui-review`.)

Display the review result summary and score from UI-REVIEW.md if produced. Continue to iterate step regardless of result — hooks at this point are advisory, not blocking.

</step>

<step name="smart_discuss">

## Smart Discuss

> Full instructions are in `gsd-core/references/autonomous-smart-discuss.md`. Read that file now and follow it exactly.

Smart discuss is an autonomous-optimized variant of `gsd-discuss-phase`. It proposes grey area answers in batch tables — the user accepts or overrides per area — and writes an identical CONTEXT.md to what discuss-phase produces.

**Inputs:** `PHASE_NUM` from execute_phase.

Read and execute: `$HOME/.claude/gsd-core/references/autonomous-smart-discuss.md`

</step>

<step name="iterate">

## 4. Iterate

**If `ONLY_PHASE` is set:** Do not iterate. Proceed directly to lifecycle step (which exits cleanly per single-phase mode).

**If `TO_PHASE` is set and current phase number >= `TO_PHASE`:** The target phase has been reached. Do not iterate further. Display:

```
### GSD ► AUTONOMOUS ▸ --to ${TO_PHASE} REACHED

 Completed through phase ${TO_PHASE} as requested.
 Remaining phases were not executed.

 Resume with: /gsd:autonomous --from ${next_incomplete_phase}
```

Proceed to lifecycle step (partial completion skips audit/complete/cleanup). Exit cleanly.

**Otherwise:** After each phase, re-read manager projection:

```bash
INIT_MANAGER=$(gsd_run query init.manager)
if [[ "$INIT_MANAGER" == @file:* ]]; then INIT_MANAGER=$(cat "${INIT_MANAGER#@file:}"); fi
STATE_CONTENT=$(cat .planning/STATE.md 2>/dev/null || true)
```

Re-filter incomplete phases using discover_phases logic: keep phases where `phase_complete !== true` or `verification_status !== "passed"`, drop deferred phases from the autonomous queue, re-apply `--from` / `--to`, then sort by number ascending.

Read STATE.md fresh:

```bash
cat .planning/STATE.md
```

Check for blockers in the Blockers/Concerns section. If blockers are found, go to handle_blocker with the blocker description.

If incomplete phases remain: proceed to next phase, loop back to execute_phase.

If no runnable phases remain but deferred phases were skipped, display `Autonomous run stopped with deferred verification phases still pending. Resume them with the commands listed in Deferred Verification.` Proceed to lifecycle only if every non-deferred phase is complete; otherwise go to handle_blocker.

**Interactive mode overlap:** When `INTERACTIVE` is set, Codex can overlap discuss for Phase N+1 with background plan+execute for Phase N. Other runtimes keep plan/execute inline, so phases stay sequential:
1. After discuss completes for Phase N, dispatch plan+execute as background agents
2. Immediately start discuss for Phase N+1 (the next incomplete phase) while Phase N builds
3. Before starting plan for Phase N+1, wait for Phase N's execute agent to complete and handle its post-execution routing (verification, gap closure, etc.)

The main context only accumulates discuss conversations; background plan/execute work stays isolated in its agents.

If all phases complete, proceed to lifecycle step.

</step>

<step name="lifecycle">

## 5. Lifecycle

**If `ONLY_PHASE` is set:** Skip lifecycle. A single phase does not trigger audit/complete/cleanup. Display:

```
### GSD ► AUTONOMOUS ▸ PHASE ${ONLY_PHASE} COMPLETE ✓

 Phase ${ONLY_PHASE}: ${PHASE_NAME} — Done
 Mode: Single phase (--only)

 Lifecycle skipped — run /gsd:autonomous without --only
 after all phases complete to trigger audit/complete/cleanup.
```

Exit cleanly.

**Otherwise:** After all phases complete, run the milestone lifecycle sequence: audit → complete → cleanup.

Display lifecycle transition banner:

```
### GSD ► AUTONOMOUS ▸ LIFECYCLE

 All phases complete → Starting lifecycle: audit → complete → cleanup
 Milestone: {milestone_version} — {milestone_name}
```

**5a. Audit**

```
Skill(skill="gsd-audit-milestone")
```

After audit completes, detect the result:

```bash
AUDIT_FILE=".planning/v${milestone_version}-MILESTONE-AUDIT.md"
AUDIT_STATUS=$(grep "^status:" "${AUDIT_FILE}" 2>/dev/null | head -1 | cut -d: -f2 | tr -d ' ')
```

**If AUDIT_STATUS is empty** (no audit file or no status field):

Go to handle_blocker: "Audit did not produce results — audit file missing or malformed."

**If `passed`:**

Display:
```
Audit ✅ passed — proceeding to complete milestone
```

Proceed to 5b (no user pause — per CTRL-01).

**If `gaps_found`:**

Read the gaps summary from the audit file. Display:
```
⚠ Audit: Gaps Found
```

Ask user via AskUserQuestion:
- **question:** "Milestone audit found gaps. How to proceed?"
- **options:** "Continue anyway — accept gaps" / "Stop — fix gaps manually"

On **"Continue anyway"**: Display `Audit ⏭ Gaps accepted — proceeding to complete milestone` and proceed to 5b.

On **"Stop"**: Go to handle_blocker with "User stopped — audit gaps remain. Run /gsd:audit-milestone to review, then /gsd:complete-milestone when ready."

**If `tech_debt`:**

Read the tech debt summary from the audit file. Display:
```
⚠ Audit: Tech Debt Identified
```

Show the summary, then ask user via AskUserQuestion:
- **question:** "Milestone audit found tech debt. How to proceed?"
- **options:** "Continue with tech debt" / "Stop — address debt first"

On **"Continue with tech debt"**: Display `Audit ⏭ Tech debt acknowledged — proceeding to complete milestone` and proceed to 5b.

On **"Stop"**: Go to handle_blocker with "User stopped — tech debt to address. Run /gsd:audit-milestone to review details."

**5b. Complete Milestone**

```
Skill(skill="gsd-complete-milestone", args="${milestone_version}")
```

After complete-milestone returns, verify it produced output:

```bash
ls .planning/milestones/v${milestone_version}-ROADMAP.md 2>/dev/null || true
```

If the archive file does not exist, go to handle_blocker: "Complete milestone did not produce expected archive files."

**5c. Cleanup**

```
Skill(skill="gsd-cleanup")
```

Cleanup shows its own dry-run and asks user for approval internally — this is an acceptable pause per CTRL-01 since it's an explicit decision about file deletion.

**5d. Final Completion**

Display final completion banner:

```
### GSD ► AUTONOMOUS ▸ COMPLETE 🎉

 Milestone: {milestone_version} — {milestone_name}
 Status: Complete ✅
 Lifecycle: audit ✅ → complete ✅ → cleanup ✅

 Ship it! 🚀
```

</step>

<step name="handle_blocker">

## 6. Handle Blocker

When any phase operation fails or a blocker is detected, present 3 options via AskUserQuestion:

**Prompt:** "Phase {N} ({Name}) encountered an issue: {description}"

**Options:**
1. **"Fix and retry"** — Re-run the failed step (discuss, plan, or execute) for this phase
2. **"Skip this phase"** — Mark phase as skipped, continue to the next incomplete phase
3. **"Stop autonomous mode"** — Display summary of progress so far and exit cleanly

**On "Fix and retry":** Loop back to the failed step within execute_phase. Track the retry count per phase + step (`RETRY_COUNT`, kept in memory for the run). If the same step fails again after retry, re-present these options. **Retry ceiling (#3210):** once the same phase step has failed 3 "Fix and retry" attempts, do NOT re-present the options — escalate to a terminal `needs_human` halt: display `Phase {N} ⛔ {Name} — needs_human`, list the unmet items (the blocker description from each attempt), append/update a `## Needs Human` section in STATE.md (`| ${PHASE_NUM} | needs_human | resolve blocker, then /gsd:autonomous --from ${PHASE_NUM} |`), and stop autonomous mode with the standard stopped-summary banner. A blocker that survives 3 fix attempts is an operator gate, not an executable gap — retrying it again just burns hours.

**On "Skip this phase":** Log `Phase {N} ⏭ {Name} — Skipped by user` and proceed to iterate.

**On "Stop autonomous mode":** Display progress summary:

```
### GSD ► AUTONOMOUS ▸ STOPPED

 Completed: {list of completed phases}
 Skipped: {list of skipped phases}
 Remaining: {list of remaining phases}

 Resume with: /gsd:autonomous ${ONLY_PHASE ? "--only " + ONLY_PHASE : "--from " + next_phase}${TO_PHASE ? " --to " + TO_PHASE : ""}
```

</step>

</process>

<success_criteria>
- [ ] All incomplete phases executed in order (smart discuss → ui-phase → plan → execute → ui-review each)
- [ ] Smart discuss proposes grey area answers in tables, user accepts or overrides per area
- [ ] Progress banners displayed between phases
- [ ] Execute-phase invoked with --no-transition (autonomous manages transitions)
- [ ] Post-execution verification reads VERIFICATION.md and routes on status
- [ ] Passed verification → automatic continue to next phase
- [ ] Human-needed verification → user prompted to validate or skip
- [ ] Gaps-found → user offered gap closure, continue, or stop
- [ ] Gap closure limited to 1 retry (prevents infinite loops)
- [ ] Plan-phase and execute-phase failures route to handle_blocker
- [ ] ROADMAP.md re-read after each phase (catches inserted phases)
- [ ] STATE.md checked for blockers before each phase
- [ ] Blockers handled via user choice (retry / skip / stop)
- [ ] Final completion or stop summary displayed
- [ ] After all phases complete, lifecycle step is invoked (not manual suggestion)
- [ ] Lifecycle transition banner displayed before audit
- [ ] Audit invoked via Skill(skill="gsd-audit-milestone")
- [ ] Audit result routing: passed → auto-continue, gaps_found → user decides, tech_debt → user decides
- [ ] Audit technical failure (no file/no status) routes to handle_blocker
- [ ] Complete-milestone invoked via Skill() with ${milestone_version} arg
- [ ] Cleanup invoked via Skill() — internal confirmation is acceptable (CTRL-01)
- [ ] Final completion banner displayed after lifecycle
- [ ] Progress bar uses phase number / total milestone phases (not position among incomplete), with fallback display when phase numbers exceed total
- [ ] Smart discuss documents relationship to discuss-phase with CTRL-03 note
- [ ] Frontend phases get UI-SPEC generated before planning (step 3a.5) if not already present
- [ ] Frontend phases get UI review audit after successful execution (step 3d.5) if UI-SPEC exists
- [ ] UI phase and UI review respect workflow.ui_phase and workflow.ui_review config toggles
- [ ] UI review is advisory (non-blocking) — phase proceeds to iterate regardless of score
- [ ] `--only N` restricts execution to exactly one phase
- [ ] `--only N` skips lifecycle step (audit/complete/cleanup)
- [ ] `--only N` exits cleanly after single phase completes
- [ ] `--only N` on already-complete phase exits with message
- [ ] `--only N` handle_blocker resume message uses --only flag
- [ ] `--to N` stops execution after phase N completes (halts at iterate step)
- [ ] `--to N` filters out phases with number > N during discovery
- [ ] `--to N` displays "Stopping after phase N" in startup banner
- [ ] `--to N` on already completed target exits with "already completed" message
- [ ] `--to N` compatible with `--from N` (run phases from M to N)
- [ ] `--to N` handle_blocker resume message preserves --to flag
- [ ] `--to N` skips lifecycle when not all milestone phases complete
- [ ] `--interactive` runs discuss inline via gsd-discuss-phase (asks questions, waits for user)
- [ ] `--interactive` dispatches plan and execute as background agents on Codex (the only runtime where a backgrounded agent can nest subagents); runs them inline on all other runtimes
- [ ] `--interactive` enables pipeline parallelism (discuss Phase N+1 while Phase N builds) on Codex; phases run sequentially on all other runtimes
- [ ] `--interactive` main context only accumulates discuss conversations on Codex (on all other runtimes, inline plan/execute also accumulate)
- [ ] `--interactive` waits for background agents before post-execution routing
- [ ] `--interactive` compatible with `--only`, `--from`, and `--to` flags
- [ ] `--converge` routes planning through `gsd-plan-review-convergence`
- [ ] `--cross-ai` is accepted as an alias for `--converge`
- [ ] `--converge` fails fast with enable instructions when `workflow.plan_review_convergence=false`
- [ ] `--converge` forwards reviewer selector flags and `--max-cycles N`
- [ ] Default autonomous planning remains `gsd-plan-phase` when convergence is not requested
</success_criteria>

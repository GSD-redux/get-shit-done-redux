<purpose>
Check project progress, summarize recent work and what's ahead, then intelligently route to the next action — either executing an existing plan or creating the next one. Provides situational awareness before continuing work.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="init_context">
**Load progress context (paths only):**

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(gsd_run query init.progress)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Extract from init JSON: `project_exists`, `roadmap_exists`, `state_exists`, `phases`, `current_phase`, `next_phase`, `milestone_version`, `completed_count`, `phase_count`, `paused_at`, `state_path`, `roadmap_path`, `project_path`, `config_path`.

```bash
DISCUSS_MODE=$(gsd_run query config-get workflow.discuss_mode 2>/dev/null || echo "discuss")
```

If `project_exists` is false (no `.planning/` directory):

```
No planning structure found.

Run /gsd:new-project to start a new project.
```

Exit.

If missing STATE.md: suggest `/gsd:new-project`.

**If ROADMAP.md missing but PROJECT.md exists:**

This means a milestone was completed and archived. Go to **Route F** (between milestones).

If missing both ROADMAP.md and PROJECT.md: suggest `/gsd:new-project`.
</step>

<step name="load">
**Use structured extraction from `gsd-tools.cjs query` (or legacy gsd-tools.cjs):**

Instead of reading full files, use targeted tools to get only the data needed for the report:
- `ROADMAP=$(gsd-tools.cjs query roadmap.analyze)`
- `STATE=$(gsd-tools.cjs query state-snapshot)`

This minimizes orchestrator context usage.
</step>

<step name="analyze_roadmap">
**Get comprehensive roadmap analysis (replaces manual parsing):**

```bash
ROADMAP=$(gsd_run query roadmap.analyze)
```

This returns structured JSON with:
- All phases with disk status (complete/partial/planned/empty/no_directory)
- Goal and dependencies per phase
- Plan and summary counts per phase
- Aggregated stats: total plans, summaries, progress percent
- Current and next phase identification

Use this instead of manually reading/parsing ROADMAP.md.
</step>

<step name="recent">
**Gather recent work context:**

- Find the 2-3 most recent SUMMARY.md files
- Use `summary-extract` for efficient parsing:
  ```bash
  gsd_run query summary-extract <path> --fields one_liner
  ```
- This shows "what we've been working on"
  </step>

<step name="position">
**Parse current position from init context and roadmap analysis:**

- Use `current_phase` and `next_phase` from `$ROADMAP`
- Note `paused_at` if work was paused (from `$STATE`)
- Count pending todos: use `init todos` or `list-todos`
- Check for active debug sessions: `(ls .planning/debug/*.md 2>/dev/null || true) | grep -v resolved | wc -l`
  </step>

<step name="report">
> ⚠️ Context authority: PROJECT.md, STATE.md, and ROADMAP.md are the authoritative sources
> for project name, milestone, current phase, and next-step routing. CLAUDE.md ## Project
> blocks are a secondary config aid that may be significantly stale — do NOT use the
> CLAUDE.md project description as a source for any progress report field.

**Generate progress bar from `gsd-tools.cjs query progress` / `progress.json`, then present rich status report:**

```bash
# Get formatted progress bar
PROGRESS_BAR=$(gsd_run query progress.bar --raw)
```

Present:

```
# [Project Name]

**Progress:** {PROGRESS_BAR}
**Profile:** [quality/balanced/budget/inherit]
**Discuss mode:** {DISCUSS_MODE}

## Recent Work
- [Phase X, Plan Y]: [what was accomplished - 1 line from summary-extract]
- [Phase X, Plan Z]: [what was accomplished - 1 line from summary-extract]

## Current Position
Phase [N] of [total]: [phase-name]
Plan [M] of [phase-total]: [status]
CONTEXT: [✓ if has_context | - if not]

## Key Decisions Made
- [extract from $STATE.decisions[]]
- [e.g. jq -r '.decisions[].decision' from state-snapshot]

## Blockers/Concerns
- [extract from $STATE.blockers[]]
- [e.g. jq -r '.blockers[].text' from state-snapshot]

## Pending Todos
- [count] pending — /gsd:capture --list to review

## Open Windows
- [count] open in `.planning/WINDOWS.md` — /gsd:ship blocks while any remain
(Only show this section if count > 0; suppressed when ledger is empty or absent)

```bash
WINDOWS_STATUS=$(gsd_run windows status --raw 2>/dev/null || echo '')
WINDOWS_OPEN=$(printf '%s' "$WINDOWS_STATUS" | jq -r '.ledger.open_count // 0' 2>/dev/null || echo 0)
WINDOWS_WAIVED=$(printf '%s' "$WINDOWS_STATUS" | jq -r '.ledger.waived_count // 0' 2>/dev/null || echo 0)
```

Render `Open Windows` only when `$WINDOWS_OPEN` is greater than `0` (or `$WINDOWS_WAIVED` is greater than `0`, so an auditable deferral history remains visible). Phrase: `{WINDOWS_OPEN} open, {WINDOWS_WAIVED} waived — resolves with /gsd:ship gate; inspect via gsd_run windows status`. The ledger is cross-phase; the count is the project total, not the current phase's.


## Active Debug Sessions
- [count] active — /gsd:debug to continue
(Only show this section if count > 0)

## What's Next
[Next phase/plan objective from roadmap analyze]
```

</step>

<step name="mvp_display">
**MVP-mode display (when phase has `**Mode:** mvp` in ROADMAP.md).**

Resolve `MVP_MODE` per phase via the centralized resolver. progress has no `--mvp` CLI flag (mode is inherited from the planned phase), so we omit `--cli-flag`:

```bash
MVP_MODE=$(gsd_run query phase.mvp-mode "${PHASE_NUMBER}" --pick active)
```

When `MVP_MODE=true`, the per-phase progress block adds a **user-flow status** sub-block sourced from the phase's PLAN.md task names. Each task whose name reads like a user-visible capability (e.g., "Register flow", "Login flow", "Password reset") is rendered as a status line:

```
Phase 1 — User Auth MVP
  ✅ Walking Skeleton complete           ← from SKELETON.md existence
  ✅ Register flow working               ← from PLAN.md task with summary
  ✅ Login flow working                  ← from PLAN.md task with summary
  🔄 Password reset (in progress)        ← from PLAN.md task without summary
  ⬜ Email verification                  ← from PLAN.md task not yet started
```

**User-flow filter:** Tasks whose names are technical-sounding ("Wire DB schema", "Create migration", "Bump deps") are NOT rendered as user-flow status lines. Heuristic: a task name is user-flow-shaped if it ends in "flow", "page", "screen", or starts with a verb the user would recognize ("Register", "Login", "Upload", "View"). Tasks that fail the heuristic still count toward the standard task progress total but don't appear in the user-flow sub-block.

When `MVP_MODE=false` (mode is null, absent, or the phase has no `**Mode:**` line), fall back to the standard display path — no behavioral change.
</step>

<step name="route">
**Determine next action based on verified counts.**

**Step 0: Resume-incomplete-phase invariant (Route 0)**

Before any current-phase-scoped counting, scan ALL phases for incomplete execution. This catches the case where STATE.md's `current_phase` was advanced past the phase that actually has unfinished work (common after a mid-execution session death from hang, token exhaustion, or API disruption). Without this guard, the current-phase-scoped count in Step 1 would inspect the wrong phase and the routing would skip the unfinished work.

**Skip if `--no-resume` or `--force` is present in `$ARGUMENTS`.**

Scan all phases via the `$ROADMAP` JSON already loaded in `analyze_roadmap`. For each phase entry, compare `plans` length to `summaries` length using the same plans-without-summaries predicate as `determine_next_action` Route 4 (`plans.length > summaries.length`). Stop at the first (lowest-numbered) phase where the predicate is true. Record its phase number as `INCOMPLETE_PHASE`.

If `$ROADMAP` is empty or the query failed, surface a warning rather than silently proceeding:

```bash
INCOMPLETE_PHASE=""
if [ -z "$ROADMAP" ]; then
  echo "⚠ WARNING: resume-incomplete-phase scan could not run (\$ROADMAP is empty)." >&2
  echo "  The incomplete-phase invariant (#160) could not be verified." >&2
  echo "  Review project state carefully before continuing." >&2
else
  for PHASE_NUM in $(echo "$ROADMAP" | jq -r '.phases[] | (.number // .phase_number)'); do
    PHASE_DATA=$(echo "$ROADMAP" | jq --arg n "$PHASE_NUM" '.phases[] | select((.number // .phase_number) == ($n | tonumber))')
    PLAN_COUNT=$(echo "$PHASE_DATA" | jq '(.plans // []) | length')
    SUMMARY_COUNT=$(echo "$PHASE_DATA" | jq '(.summaries // []) | length')
    if [ "${PLAN_COUNT:-0}" -gt "${SUMMARY_COUNT:-0}" ]; then
      INCOMPLETE_PHASE="$PHASE_NUM"
      break
    fi
  done
fi
```

**If `INCOMPLETE_PHASE` is non-empty:** emit a one-line resume notice in the routing output and route to `/gsd:execute-phase ${INCOMPLETE_PHASE}` instead of running Step 1's current-phase routing. The progress report (already displayed by the `report` step above) gives the user full project status before this routing decision is shown.

```
---

## ▶ Next Up — Resuming incomplete Phase ${INCOMPLETE_PHASE}

`/clear` then:

`/gsd:execute-phase ${INCOMPLETE_PHASE} ${GSD_WS}`

(plans without summaries detected; use --no-resume to skip this check and route by current_phase instead; --force to skip all gates)

---
```

Then exit the route step. Do NOT run Steps 1 through Routes A-F.

**If `INCOMPLETE_PHASE` is empty:** continue to Step 1.

**Step 1: Count plans, summaries, and issues in current phase**

List files in the current phase directory:

```bash
(ls -1 .planning/phases/[current-phase-dir]/*-PLAN.md 2>/dev/null || true) | wc -l
(ls -1 .planning/phases/[current-phase-dir]/*-SUMMARY.md 2>/dev/null || true) | wc -l
(ls -1 .planning/phases/[current-phase-dir]/*-UAT.md 2>/dev/null || true) | wc -l
```

State: "This phase has {X} plans, {Y} summaries."

**Step 1.5: Check for unaddressed UAT gaps**

Check for UAT.md files with status "diagnosed" (has gaps needing fixes).

```bash
# Check for diagnosed UAT with gaps or partial (incomplete) testing
grep -l "status: diagnosed\|status: partial" .planning/phases/[current-phase-dir]/*-UAT.md 2>/dev/null || true
```

Track:
- `uat_with_gaps`: UAT.md files with status "diagnosed" (gaps need fixing)
- `uat_partial`: UAT.md files with status "partial" (incomplete testing)

**Step 1.6: Cross-phase health check**

Scan ALL phases in the current milestone for outstanding verification debt using the CLI (which respects milestone boundaries via `getMilestonePhaseFilter`):

```bash
DEBT=$(gsd_run query audit-uat --raw 2>/dev/null)
```

Parse JSON for `summary.total_items` and `summary.total_files`.

Track: `outstanding_debt` — `summary.total_items` from the audit.

**If outstanding_debt > 0:** Add a warning section to the progress report output (in the `report` step), placed between "## What's Next" and the route suggestion:

```markdown
## Verification Debt ({N} files across prior phases)

| Phase | File | Issue |
|-------|------|-------|
| {phase} | {filename} | {pending_count} pending, {skipped_count} skipped, {blocked_count} blocked |
| {phase} | {filename} | human_needed — {count} items |
| {phase} | {filename} | {unresolved_count} deferred items |

Review: `/gsd:audit-uat ${GSD_WS}` — full cross-phase audit
Resume testing: `/gsd:verify-work {phase} ${GSD_WS}` — retest specific phase
```

This is a WARNING, not a blocker — routing proceeds normally. The debt is visible so the user can make an informed choice.

**Step 1.7: Check verification status for the current phase**

A phase whose verification is missing, unknown, `gaps_found`, or `human_needed` is NOT complete, even when every PLAN.md has a matching SUMMARY.md. The count-based status (`roadmap.analyze`) only sees plans/summaries, so without this check such a phase is reported complete and routing skips straight to the next phase. When the phase appears count-complete (`summaries = plans AND plans > 0`), consult the verification report (the same `verification.status` gate `ship` and `execute-phase` use, from #651):

```bash
PHASE_DIR=".planning/phases/[current-phase-dir]"
VERIFICATION=$(gsd_run query verification.status "${PHASE_DIR}" 2>/dev/null)
VERIFICATION_STATUS=$(printf '%s' "$VERIFICATION" | jq -r '.status' 2>/dev/null || echo "")
VERIFICATION_NEXT_ACTION=$(printf '%s' "$VERIFICATION" | jq -r '.next_action' 2>/dev/null || echo "")
```

Track: `verification_status` — the `.status` field (`passed | stale | gaps_found | human_needed | missing | unknown`). The query/projection handles a missing VERIFICATION.md (`missing`), unexpected values, and stale verification (`stale`, when summaries are newer than verification). Only `passed` routes as phase complete (Step 3); every other status routes back to close verification debt (Step 2).

**Step 2: Route based on counts**

| Condition | Meaning | Action |
|-----------|---------|--------|
| uat_partial > 0 | UAT testing incomplete | Go to **Route E.2** |
| uat_with_gaps > 0 | UAT gaps need fix plans | Go to **Route E** |
| summaries < plans | Unexecuted plans exist | Go to **Route A** |
| summaries = plans AND plans > 0 AND verification_status = missing | Phase executed; verification report missing | Go to **Route V.missing** |
| summaries = plans AND plans > 0 AND verification_status = unknown | Phase executed; verification status unknown | Go to **Route V.unknown** |
| summaries = plans AND plans > 0 AND verification_status = stale | Phase executed; verification is stale | Go to **Route V.stale** |
| summaries = plans AND plans > 0 AND verification_status = gaps_found | Phase executed; verification found gaps | Go to **Route V.gaps** |
| summaries = plans AND plans > 0 AND verification_status = human_needed | Phase executed; awaiting human verification | Go to **Route V.human** |
| summaries = plans AND plans > 0 AND verification_status = passed | Phase complete (verification passed) | Go to Step 3 |
| plans = 0 | Phase not yet planned | Go to **Route B** |

Rows are evaluated top to bottom; the first matching row wins. The `verification_status` rows must precede the passed row so non-`passed` verification is not reported as complete.

---

**Route A: Unexecuted plan exists**

Find the first PLAN.md without matching SUMMARY.md.
Read its `<objective>` section.

```
---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**{phase}-{plan}: [Plan Name]** — [objective summary from PLAN.md]

`/clear` then:

`/gsd:execute-phase {phase} ${GSD_WS}`

---
```

---

**Route B: Phase needs planning**

Check if `{phase_num}-CONTEXT.md` exists in phase directory.

Check if current phase has UI indicators:

```bash
PHASE_SECTION=$(gsd_run query roadmap.get-phase "${CURRENT_PHASE}" 2>/dev/null)
PHASE_HAS_UI=$(echo "$PHASE_SECTION" | grep -qi "UI hint.*yes" && echo "true" || echo "false")
```

**If CONTEXT.md exists:**

```
---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Phase {N}: {Name}** — {Goal from ROADMAP.md}
<sub>✓ Context gathered, ready to plan</sub>

`/clear` then:

`/gsd:plan-phase {phase-number} ${GSD_WS}`

---
```

**If CONTEXT.md does NOT exist AND phase has UI (`PHASE_HAS_UI` is `true`):**

```
---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Phase {N}: {Name}** — {Goal from ROADMAP.md}

`/clear` then:

`/gsd:discuss-phase {phase}` — gather context and clarify approach

---

**Also available:**
- `/gsd:ui-phase {phase}` — generate UI design contract (recommended for frontend phases)
- `/gsd:plan-phase {phase}` — skip discussion, plan directly
- `/gsd:discuss-phase {phase}` — include assumptions check before planning

---
```

**If CONTEXT.md does NOT exist AND phase has no UI:**

```
---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Phase {N}: {Name}** — {Goal from ROADMAP.md}

`/clear` then:

`/gsd:discuss-phase {phase} ${GSD_WS}` — gather context and clarify approach

---

**Also available:**
- `/gsd:plan-phase {phase} ${GSD_WS}` — skip discussion, plan directly
- `/gsd:discuss-phase {phase} ${GSD_WS}` — include assumptions check before planning

---
```

---

**Route E: UAT gaps need fix plans**

UAT.md exists with gaps (diagnosed issues). User needs to plan fixes.

```
---

## ⚠ UAT Gaps Found

**{phase_num}-UAT.md** has {N} gaps requiring fixes.

`/clear` then:

`/gsd:plan-phase {phase} --gaps ${GSD_WS}`

---

**Also available:**
- `/gsd:execute-phase {phase} ${GSD_WS}` — execute phase plans
- `/gsd:verify-work {phase} ${GSD_WS}` — run more UAT testing

---
```

---

**Route E.2: UAT testing incomplete (partial)**

UAT.md exists with `status: partial` — testing session ended before all items resolved.

```
---

## Incomplete UAT Testing

**{phase_num}-UAT.md** has {N} unresolved tests (pending, blocked, or skipped).

`/clear` then:

`/gsd:verify-work {phase} ${GSD_WS}` — resume testing from where you left off

---

**Also available:**
- `/gsd:audit-uat ${GSD_WS}` — full cross-phase UAT audit
- `/gsd:execute-phase {phase} ${GSD_WS}` — execute phase plans

---
```

---

**Route V.missing: verification report missing**

All plans have summaries, but canonical verification has not passed. The phase is implementation-complete, not phase-complete.

```
`/gsd:execute-phase {phase} ${GSD_WS}` — re-run execution verification
```

---

**Route V.unknown: verification status unknown**

VERIFICATION.md has an unexpected status. The phase is implementation-complete, not phase-complete.

```
`/gsd:execute-phase {phase} ${GSD_WS}` — regenerate verification
```

---

**Route V.stale: verification is stale**

VERIFICATION.md has `status: passed`, but one or more SUMMARY.md files are newer than the verification report. The phase is implementation-complete, not phase-complete.

```
`/gsd:verify-work {phase} ${GSD_WS}` — re-run verification against the latest summaries
```

---

**Route V.gaps: verification found gaps (gaps_found)**

VERIFICATION.md exists with `status: gaps_found` — verification identified gaps that need fix plans. The phase is NOT complete.

```
---

## ⚠ Verification Gaps Found

**{phase_num}-VERIFICATION.md** reports `gaps_found`. ${VERIFICATION_NEXT_ACTION}

`/clear` then:

`/gsd:plan-phase {phase} --gaps ${GSD_WS}`

---
```

---

**Route V.human: human verification required (human_needed)**

VERIFICATION.md exists with `status: human_needed` — automated checks passed but manual verification items remain. The phase is NOT complete until they are resolved.

```
---

## Human Verification Required

**{phase_num}-VERIFICATION.md** reports `human_needed`. ${VERIFICATION_NEXT_ACTION}

`/clear` then:

`/gsd:verify-work {phase} ${GSD_WS}` — resume human verification

---
```

---

**Step 3: Check milestone status (only when phase complete)**

Read ROADMAP.md and identify:
1. Current phase number
2. All phase numbers in the current milestone section

Count total phases and identify the highest phase number.

State: "Current phase is {X}. Milestone has {N} phases (highest: {Y})."

**Route based on milestone status:**

| Condition | Meaning | Action |
|-----------|---------|--------|
| current phase < highest phase | More phases remain | Go to **Route C** |
| current phase = highest phase | All phases complete | Go to **Route D** |

---

**Route C: Phase complete, more phases remain**

Read ROADMAP.md to get the next phase's name and goal.

Check if next phase has UI indicators:

```bash
NEXT_PHASE_SECTION=$(gsd_run query roadmap.get-phase "$((Z+1))" 2>/dev/null)
NEXT_HAS_UI=$(echo "$NEXT_PHASE_SECTION" | grep -qi "UI hint.*yes" && echo "true" || echo "false")
```

**If next phase has UI (`NEXT_HAS_UI` is `true`):**

```
---

## ✓ Phase {Z} Complete

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Phase {Z+1}: {Name}** — {Goal from ROADMAP.md}

`/clear` then:

`/gsd:discuss-phase {Z+1}` — gather context and clarify approach

---

**Also available:**
- `/gsd:ui-phase {Z+1}` — generate UI design contract (recommended for frontend phases)
- `/gsd:plan-phase {Z+1}` — skip discussion, plan directly
- `/gsd:verify-work {Z}` — user acceptance test before continuing

---
```

**If next phase has no UI:**

```
---

## ✓ Phase {Z} Complete

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Phase {Z+1}: {Name}** — {Goal from ROADMAP.md}

`/clear` then:

`/gsd:discuss-phase {Z+1} ${GSD_WS}` — gather context and clarify approach

---

**Also available:**
- `/gsd:plan-phase {Z+1} ${GSD_WS}` — skip discussion, plan directly
- `/gsd:verify-work {Z} ${GSD_WS}` — user acceptance test before continuing

---
```

---

**Route D: All phases complete (milestone ready to close)**

```
---

## 🎉 Milestone Complete

All {N} phases finished!

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Complete Milestone** — archive and prepare for next

`/clear` then:

`/gsd:complete-milestone ${GSD_WS}`

---

**Also available:**
- `/gsd:verify-work ${GSD_WS}` — user acceptance test before completing milestone

---
```

---

**Route F: Between milestones (ROADMAP.md missing, PROJECT.md exists)**

A milestone was completed and archived. Ready to start the next milestone cycle.

Read MILESTONES.md to find the last completed milestone version.

```
---

## ✓ Milestone v{X.Y} Complete

Ready to plan the next milestone.

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Start Next Milestone** — questioning → research → requirements → roadmap

`/clear` then:

`/gsd:new-milestone ${GSD_WS}`

---
```

</step>

<step name="edge_cases">
**Handle edge cases:**

- Phase complete but next phase not planned → offer `/gsd:plan-phase [next] ${GSD_WS}`
- All work complete → offer milestone completion
- Blockers present → highlight before offering to continue
- Handoff file exists → mention it, offer `/gsd:resume-work ${GSD_WS}`
</step>

<step name="forensic_audit">
**Forensic Integrity Audit** — only runs when `--forensic` is present in ARGUMENTS.

If `--forensic` is NOT present in ARGUMENTS: skip this step entirely. Default progress behavior (standard report + routing) is unchanged.

If `--forensic` IS present: after the standard report and routing suggestion have been displayed, append the following audit section.

---

## Forensic Integrity Audit

Running 7 deep checks against project state...

Run each check in order. For each check, emit ✓ (pass) or ⚠ (warning) with concrete evidence when a problem is found.

**Check 1 — STATE vs artifact consistency**

Read STATE.md `status` / `stopped_at` fields (from the STATE snapshot already loaded). Compare against the artifact count from the roadmap analysis. If STATE.md claims the current phase is pending/mid-flight but the artifact count shows it as complete (all PLAN.md files have matching SUMMARY.md files), flag inconsistency. Emit:
- ✓ `STATE.md consistent with artifact count` — if both agree
- ⚠ `STATE.md claims [status] but artifact count shows phase complete` — with the specific values

**Check 2 — Orphaned handoff files**

Check for existence of:
```bash
ls .planning/HANDOFF.json .planning/phases/*/.continue-here.md .planning/phases/*/*HANDOFF*.md 2>/dev/null || true
```
Also check `.planning/continue-here.md`.

Emit:
- ✓ `No orphaned handoff files` — if none found
- ⚠ `Orphaned handoff files found` — list each file path, add: `→ Work was paused mid-flight. Read the handoff before continuing.`

**Check 3 — Deferred scope drift**

Search phase artifacts (CONTEXT.md, DISCUSSION-LOG.md, BUG-BRIEF.md, VERIFICATION.md, SUMMARY.md, HANDOFF.md files under `.planning/phases/`) for patterns:
```bash
grep -rl "defer to Phase\|future phase\|out of scope Phase\|deferred to Phase" .planning/phases/ 2>/dev/null || true
```

For each match, extract the referenced phase number. Cross-reference against ROADMAP.md phase list. If the referenced phase number is NOT in ROADMAP.md, flag as deferred scope not captured.

Emit:
- ✓ `All deferred scope captured in ROADMAP` — if no mismatches
- ⚠ `Deferred scope references phase(s) not in ROADMAP` — list: file, reference text, missing phase number

**Check 4 — Memory-flagged pending work**

Check if `.planning/MEMORY.md` or `.planning/memory/` exists:
```bash
ls .planning/MEMORY.md .planning/memory/*.md 2>/dev/null || true
```

If found, grep for entries containing: `pending`, `status`, `deferred`, `not yet run`, `backfill`, `blocking`.

Emit:
- ✓ `No memory entries flagging pending work` — if none found or no MEMORY.md
- ⚠ `Memory entries flag pending/deferred work` — list the matching lines (max 5, truncated at 80 chars)

**Check 5 — Blocking operational todos**

Check for pending todos:
```bash
ls .planning/todos/pending/*.md 2>/dev/null || true
```

For files found, scan for keywords indicating operational blockers: `script`, `credential`, `API key`, `manual`, `verification`, `setup`, `configure`, `run `.

Emit:
- ✓ `No blocking operational todos` — if no pending todos or none match operational keywords
- ⚠ `Blocking operational todos found` — list the file names and matching keywords (max 5)

**Check 6 — Uncommitted code**

```bash
git status --porcelain 2>/dev/null | grep -v "^??" | grep -v "^.planning\/" | grep -v "^\.\." | head -10
```

If output is non-empty (modified/staged files outside `.planning/`), flag as uncommitted code.

Emit:
- ✓ `Working tree clean` — if no modified files outside `.planning/`
- ⚠ `Uncommitted changes in source files` — list up to 10 file paths

**Check 7 — Unresolved deferred items**

Glob every phase directory's SCOPE BOUNDARY log (executor writes out-of-scope discoveries here per `agents/gsd-executor.md`):
```bash
ls .planning/phases/*/deferred-items.md 2>/dev/null || true
```

For each `deferred-items.md` found, read its entries (bullet list, one entry per top-level `- ` line, continuation lines indented beneath it). An entry is RESOLVED only if it carries an explicit `status: resolved` field (case-insensitive) on one of its lines; every other entry — including one with no `status:` field at all — is UNRESOLVED and must be surfaced (fail-safe: never silently drop a possibly-open item).

Emit:
- ✓ `No unresolved deferred items` — if no `deferred-items.md` files exist, or every entry in every file is `status: resolved`
- ⚠ `Unresolved deferred items found` — list each file's phase directory and its unresolved entry text (max 5 per file, truncated at 80 chars)

---

After all 7 checks, display the verdict:

**If all 7 checks passed:**
```
### Verdict: CLEAN

The standard progress report is trustworthy — proceed with the routing suggestion above.
```

**If 1 or more checks failed:**
```
### Verdict: N INTEGRITY ISSUE(S) FOUND

The standard progress report may not reflect true project state.
Review the flagged items above before acting on the routing suggestion.
```

Then for each failed check, add a concrete next action:
- Check 2 (orphaned handoff): `Read the handoff file(s) and resume from where work was paused: /gsd:resume-work ${GSD_WS}`
- Check 3 (deferred scope): `Add the missing phases to ROADMAP.md or update the deferred references`
- Check 4 (memory pending): `Review the flagged memory entries and resolve or clear them`
- Check 5 (blocking todos): `Complete the operational steps in .planning/todos/pending/ before continuing`
- Check 6 (uncommitted code): `Commit or stash the uncommitted changes before advancing`
- Check 7 (unresolved deferred items): `Address each deferred item and mark it status: resolved in its deferred-items.md, or fold it into the roadmap`
- Check 1 (STATE inconsistency): `Run /gsd:verify-work ${PHASE} ${GSD_WS} to reconcile state`
</step>

</process>

<success_criteria>

- [ ] Rich context provided (recent work, decisions, issues)
- [ ] Current position clear with visual progress
- [ ] What's next clearly explained
- [ ] Smart routing: /gsd:execute-phase if plans exist, /gsd:plan-phase if not
- [ ] User confirms before any action
- [ ] Seamless handoff to appropriate gsd command
      </success_criteria>

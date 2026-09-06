@~/.claude/gsd-core/references/response-language-directive.md

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
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
FORENSIC_PARAM=""; if [[ "$ARGUMENTS" =~ (^|[[:space:]])--forensic([[:space:]]|$) ]]; then FORENSIC_PARAM="--forensic"; fi
INIT=$(gsd_run query init.progress $FORENSIC_PARAM)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Extract from init JSON: `project_exists`, `roadmap_exists`, `state_exists`, `requirements_exists`, `planning_exists`, `milestones_exists`, `init_incomplete`, `phases`, `current_phase`, `next_phase`, `milestone_version`, `completed_count`, `phase_count`, `paused_at`, `state_path`, `roadmap_path`, `project_path`, `config_path`, `phase_mvp_mode`.

```bash
DISCUSS_MODE=$(gsd_run query config-get workflow.discuss_mode --raw 2>/dev/null || echo "discuss")
```

**If `init_incomplete` is true (#4040 — interrupted bootstrap):**

`.planning/` exists but the core initialization artifacts are missing (one or more of `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md` were never created — a bootstrap that stopped partway, e.g. after PROJECT.md). This is NOT a new project, NOT a missing STATE.md, and NOT a between-milestones state — do not fall through to any of those routes. Route to initialization recovery:

```
---

## ⚠ Initialization Incomplete

A partial `.planning/` was found: project initialization started but stopped before creating all core artifacts (missing: REQUIREMENTS.md, ROADMAP.md, STATE.md — whichever `requirements_exists` / `roadmap_exists` / `state_exists` report as false).

`/clear` then:

`/gsd:new-project` — resumes initialization from the first missing artifact; existing PROJECT.md (and any already-created artifacts) are kept, not regenerated.

---
```

Exit. (The payload's `init_incomplete` is computed with the between-milestones archive case excluded — `MILESTONES.md` present means missing ROADMAP/REQUIREMENTS is archival, and that state still routes to Route F below.)

If `init_incomplete` is false and `planning_exists` is false and `project_exists` is false (no `.planning/` directory at all):

```
No planning structure found.

Run /gsd:new-project to start a new project.
```

Exit.

If missing STATE.md: suggest `/gsd:new-project`.

**If ROADMAP.md missing but PROJECT.md exists (and `init_incomplete` is false):**

This means a milestone was completed and archived. Go to **Route F** (between milestones).

If missing both ROADMAP.md and PROJECT.md: suggest `/gsd:new-project`.
</step>

<step name="load">
**Use structured extraction from `gsd_run query`:**

Instead of reading full files, use targeted tools to get only the data needed for the report:
- `ROADMAP=$(gsd_run query roadmap.analyze)`
- `STATE=$(gsd_run query state-snapshot)`

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

**Generate progress bar from `gsd_run query progress` / `progress.json`, then present rich status report:**

```bash
# Get formatted progress bar
PROGRESS_BAR=$(gsd_run query progress.bar --raw)
```

Present:

````
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
````

</step>

<!-- gsd:section id="mvp-display" when="state:phase-mvp-mode" -->
If `section_manifest` is `null` or `"mvp-display"` is in its `included` list: read and execute `gsd-core/workflows/progress/steps/mvp-display.md`. Otherwise skip — do not read the file.
<!-- /gsd:section -->

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
    # #3218: $PHASE_DATA is a `.phases[]` entry from `roadmap.analyze`, which
    # emits `plan_count`/`summary_count` SCALARS (src/roadmap.cts) — it has
    # never emitted `.plans`/`.summaries` ARRAYS. Reading those absent keys
    # (even with a `// []` fallback) always produced 0, permanently disabling
    # this resume-incomplete-phase check. Read the scalars the producer
    # actually emits.
    PLAN_COUNT=$(echo "$PHASE_DATA" | jq '.plan_count // 0')
    SUMMARY_COUNT=$(echo "$PHASE_DATA" | jq '.summary_count // 0')
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

Get plan/summary counts for the current phase from the single owner (#3218 — LIVE
counts, i.e. `status: superseded` plans excluded, matching "outstanding work"):

```bash
PHASE_COUNTS=$(gsd_run query find-phase "${CURRENT_PHASE}")
X=$(echo "$PHASE_COUNTS" | jq -r '.plan_count // 0')
Y=$(echo "$PHASE_COUNTS" | jq -r '.summary_count // 0')
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

Scan ALL phases for outstanding verification debt using the CLI. Milestone scoping note (#3782): the audit milestone-filters the ACTIVE phase tree (`getMilestonePhaseFilter`), and deliberately adds ARCHIVED milestone trees unfiltered — each archived result carries an `archived_milestone` stamp. `summary.total_items` spans BOTH populations, so never read it as current-milestone debt.

```bash
DEBT=$(gsd_run query audit-uat --raw 2>/dev/null)
# A cross-population audit is exactly the payload that can exceed the CLI's
# ~50KB stdout budget (io.cjs swaps in an `@file:<tmp>` pointer) — unwrap it
# before jq, the same pattern Step 1's INIT fetch uses, or every counter
# below silently reads 0.
if [[ "$DEBT" == @file:* ]]; then DEBT=$(cat "${DEBT#@file:}"); fi
```

Segment the debt by population before counting (#3782):

```bash
CURRENT_DEBT=$(printf '%s' "$DEBT" | jq '[.results[] | select(has("archived_milestone") | not)] | map(.items | length) | add // 0' 2>/dev/null || echo 0)
ARCHIVED_DEBT=$(printf '%s' "$DEBT" | jq '[.results[] | select(has("archived_milestone"))] | map(.items | length) | add // 0' 2>/dev/null || echo 0)
```

Track: `outstanding_debt` — `CURRENT_DEBT`, the non-archived (current-milestone) count. Track `archived_debt` — `ARCHIVED_DEBT`, the still-open items in already-archived milestones. Track `parse_gap_files` — `summary.parse_gap_files` from the audit.

Archived debt stays VISIBLE — an item archived still-open is still open (the archived set can include an unrun security-boundary test). Render it as its own labeled line; never fold it into the current-milestone total and never filter it away.

`summary.parse_gap_files` counts EVERY file with `parse_gap: true`, archived or not — deliberately cross-population, unlike `outstanding_debt` (which #3782 scopes to non-archived results). An outstanding item does not stop mattering because its phase belongs to an already-archived milestone: a deferred human-UAT scenario or a `skipped` live-stack test is exactly what gets archived still-open, so an archived parse gap is exactly as much unread outstanding work as an archived `result: pending` row — it surfaces through `parse_gap_files` and the unparsed row below, keeping the whole cross-population picture visible.

**If outstanding_debt > 0 OR archived_debt > 0 OR parse_gap_files > 0:** Add a warning section to the progress report output (in the `report` step), placed between "## What's Next" and the route suggestion:

```markdown
## Verification Debt ({N} items across current-milestone phases; {M} items still open in archived milestones)

| Phase | File | Issue |
|-------|------|-------|
| {phase} | {filename} | {pending_count} pending, {skipped_count} skipped, {blocked_count} blocked |
| {phase} | {filename} | human_needed — {count} items |
| {phase} | {filename} | {unresolved_count} deferred items |
| {phase} | {filename} | unparsed — test blocks with no readable `result:` line |

Review: `/gsd:audit-uat ${GSD_WS}` — full cross-phase audit
Resume testing: `/gsd:verify-work {phase} ${GSD_WS}` — retest specific phase
```

The unparsed row comes from `results` entries with `parse_gap: true` (`summary.parse_gap_files` counts exactly those, archived or not). This is a WARNING, not a blocker — routing proceeds normally. The debt is visible so the user can make an informed choice.

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
---

## Verification Report Missing

**Phase {phase}** has all plans summarized, but no canonical `*-VERIFICATION.md` exists yet. ${VERIFICATION_NEXT_ACTION}

`/clear` then:

`/gsd:execute-phase {phase} ${GSD_WS}` — resumes at the verification gates

---
```

---

**Route V.unknown: verification status unknown**

VERIFICATION.md has an unexpected status. The phase is implementation-complete, not phase-complete.

```
---

## Verification Status Unexpected

**Phase {phase}** has all plans summarized, but its `*-VERIFICATION.md` reports an unexpected status. ${VERIFICATION_NEXT_ACTION}

`/clear` then:

`/gsd:execute-phase {phase} ${GSD_WS}` — regenerate verification

---
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

<!-- gsd:section id="forensic-audit" when="flag:--forensic" -->
If `section_manifest` is `null` or `"forensic-audit"` is in its `included` list: read and execute `gsd-core/workflows/progress/steps/forensic-audit.md`. Otherwise skip — do not read the file.
<!-- /gsd:section -->

</process>

<success_criteria>

- [ ] Rich context provided (recent work, decisions, issues)
- [ ] Current position clear with visual progress
- [ ] What's next clearly explained
- [ ] Smart routing: /gsd:execute-phase if plans exist, /gsd:plan-phase if not
- [ ] User confirms before any action
- [ ] Seamless handoff to appropriate gsd command
      </success_criteria>

<purpose>
Detect current project state and automatically advance to the next logical GSD workflow step.
Reads project state to determine: discuss → plan → execute → verify → complete progression.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="detect_state">
Read project state to determine current position:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# Get state snapshot
gsd_run query state.json 2>/dev/null || echo "{}"
```

Also read:
- `.planning/STATE.md` — current phase, progress, plan counts
- `.planning/ROADMAP.md` — milestone structure and phase list

Extract:
- `current_phase` — which phase is active
- `plan_of` / `plans_total` — plan execution progress
- `progress` — overall percentage
- `status` — active, paused, etc.

If no `.planning/` directory exists:
```
No GSD project detected. Run `/gsd:new-project` to get started.
```
Exit.
</step>

<step name="safety_gates">
Run hard-stop checks before routing. Exit on first hit unless `--force` was passed.

If `--force` flag was passed, skip all gates, Route 0, and the prior-phase completeness prompt.
Print a one-line warning: `⚠ --force: skipping safety gates`
Then proceed directly to `determine_next_action`. (Route 0 and `prior_phase_completeness` are NOT reached under `--force`.)

**Gate 1: Unresolved checkpoint**
Check if `.planning/.continue-here.md` exists:
```bash
[ -f .planning/.continue-here.md ]
```
If found:
```
⛔ Hard stop: Unresolved checkpoint

`.planning/.continue-here.md` exists — a previous session left
unfinished work that needs manual review before advancing.

Read the file, resolve the issue, then delete it to continue.
Use `--force` to bypass this check.
```
Exit (do not route).

**Gate 2: Error state**
Check if STATE.md contains `status: error` or `status: failed`:
If found:
```
⛔ Hard stop: Project in error state

STATE.md shows status: {status}. Resolve the error before advancing.
Run `/gsd:health` to diagnose, or manually fix STATE.md.
Use `--force` to bypass this check.
```
Exit.

**Gate 3: Unchecked verification**
Check if the current phase has a VERIFICATION.md with any `FAIL` items that don't have overrides:
If found:
```
⛔ Hard stop: Unchecked verification failures

VERIFICATION.md for phase {N} has {count} unresolved FAIL items.
Address the failures or add overrides before advancing to the next phase.
Use `--force` to bypass this check.
```
Exit.

After all three hard-stop gates pass, continue to `resume_incomplete_phase`.
</step>

<step name="resume_incomplete_phase">
**Hard invariant: any phase with PLAN.md files lacking matching SUMMARY.md files must be completed before `/gsd:progress --next` routes to any forward action.**

This catches the common failure mode where a session died mid-execution (hang, token exhaustion, API connection drop) and STATE.md's `current_phase` got advanced past the phase that actually has unfinished work. Without this gate, `/gsd:progress --next` would route by `current_phase` and silently skip the partially-executed phase.

**Skip if `--no-resume` was passed** (fall through to `prior_phase_completeness`). (`--force` already bypassed all gates and Route 0 at `safety_gates` — it never reaches this step.)

**Why Route 0 runs here (after Gates 1-3, before the prior-phase defer prompt):** This step is a hard invariant independent of `current_phase`'s value — it must run before any routing rule that reads `current_phase`. Gates 1-3 are cheap repo/state validity checks that must always run — skipping them on the resume path would risk advancing into a broken-state project. The prior-phase completeness-scan DEFER PROMPT, however, must NOT run in the default (no-flag) case when Route 0 is about to resume the phase automatically: that would force a double-decision (prompt first, then resume anyway), overriding the user's choice. Route 0 placed here means: default = resume silently (no defer prompt); `--no-resume` = skip Route 0 and fall through to the prior-phase defer prompt in `prior_phase_completeness`; `--force` = jump straight to `determine_next_action` at `safety_gates` (never reaches Route 0 or `prior_phase_completeness` at all).

Scan ALL phases in ROADMAP order (lowest-numbered to highest) for incomplete-execution state. Use `gsd_run query roadmap.analyze` to get the phase list, then for each phase number `N` query `gsd_run query find-phase <N>` JSON and inspect its `plans` and `summaries` arrays. A phase is **incomplete-execution** when `plans.length > summaries.length` (at least one PLAN.md has no matching SUMMARY.md).

Stop at the first such phase. Record its phase number as `INCOMPLETE_PHASE`. This is the lowest-numbered phase that needs continued execution.

Illustrative bash:

```bash
INCOMPLETE_PHASE=""
ROADMAP_JSON=$(gsd_run query roadmap.analyze)
if [ $? -ne 0 ] || [ -z "$ROADMAP_JSON" ]; then
  echo "⚠ WARNING: resume-incomplete-phase scan could not run (roadmap.analyze failed)." >&2
  echo "  The incomplete-phase invariant (#160) could not be verified." >&2
  echo "  Proceeding to prior-phase completeness check — review project state carefully." >&2
  # Fall through to prior_phase_completeness rather than silently skipping
else
  for PHASE_NUM in $(echo "$ROADMAP_JSON" | jq -r '.phases[] | (.number // .phase_number // empty)'); do
    PHASE_JSON=$(gsd_run query find-phase "$PHASE_NUM")
    if [ $? -ne 0 ] || [ -z "$PHASE_JSON" ]; then
      echo "⚠ WARNING: Could not query phase $PHASE_NUM — skipping in resume scan." >&2
      continue
    fi
    PLAN_COUNT=$(echo "$PHASE_JSON" | jq '(.plans // []) | length')
    SUMMARY_COUNT=$(echo "$PHASE_JSON" | jq '(.summaries // []) | length')
    if [ "${PLAN_COUNT:-0}" -gt "${SUMMARY_COUNT:-0}" ]; then
      INCOMPLETE_PHASE="$PHASE_NUM"
      break
    fi
  done
fi
```

**If `INCOMPLETE_PHASE` is non-empty:** route to `/gsd:execute-phase $INCOMPLETE_PHASE` and exit. Display a one-line notice before invoking:

```
▶ Resuming incomplete Phase ${INCOMPLETE_PHASE} (plans without summaries detected)
  /gsd:execute-phase ${INCOMPLETE_PHASE}
  (use --no-resume to skip this check and defer via the prior-phase prompt)
```

Then invoke via SlashCommand. Do not continue to subsequent steps.

**If `INCOMPLETE_PHASE` is empty:** continue to `prior_phase_completeness`.
</step>

<step name="prior_phase_completeness">
**Prior-phase completeness scan (runs when `--no-resume` was passed and Route 0 was skipped, or when Route 0 found no incomplete-execution phases in the default case). NOT reached under `--force` — that flag jumps directly to `determine_next_action` at `safety_gates`.**

**Prior-phase completeness scan:**
Scan all phases that precede the current phase in ROADMAP.md order for incomplete work. For each prior phase number `N`, use `gsd_run query find-phase <N>` JSON (plans, summaries, incomplete_plans, etc.) to inspect that phase.

Detect three categories of incomplete work:
1. **Plans without summaries** — a PLAN.md exists in a prior phase directory but no matching SUMMARY.md exists (execution started but not completed).
2. **Verification failures not overridden** — a prior phase has a VERIFICATION.md with `FAIL` items that have no override annotation.
3. **CONTEXT.md without plans** — a prior phase directory has a CONTEXT.md but no PLAN.md files (discussion happened, planning never ran).

If no incomplete prior work is found, continue to `determine_next_action` silently with no interruption.

If incomplete prior work is found, show a structured completeness report:
```
⚠ Prior phase has incomplete work

Phase {N} — "{name}" has unresolved items:
  • Plan {N}-{M} ({slug}): executed but no SUMMARY.md
  [... additional items ...]

Advancing before resolving these may cause:
  • Verification gaps — future phase verification won't have visibility into what prior phases shipped
  • Context loss — plans that ran without summaries leave no record for future agents

Options:
  [C] Continue and defer these items to backlog
  [S] Stop and resolve manually (recommended)
  [F] Force advance without recording deferral

Choice [S]:
```

**If the user chooses "Stop" (S or Enter/default):** Exit without routing.

**If the user chooses "Continue and defer" (C):**
1. For each incomplete item, create a backlog entry in `ROADMAP.md` under `## Backlog` using the existing `999.x` numbering scheme:
```markdown
### Phase 999.{N}: Follow-up — Phase {src} incomplete plans (BACKLOG)

**Goal:** Resolve plans that ran without producing summaries during Phase {src} execution
**Source phase:** {src}
**Deferred at:** {date} during /gsd:progress --next advancement to Phase {dest}
**Plans:**
- [ ] {N}-{M}: {slug} (ran, no SUMMARY.md)
```
2. Commit the deferral record:
```bash
gsd_run query commit "docs: defer incomplete Phase {src} items to backlog" \
  --files .planning/ROADMAP.md
```
3. Continue routing to `determine_next_action` immediately — no second prompt.

**If the user chooses "Force" (F):** Continue to `determine_next_action` without recording deferral.
</step>

<step name="spike_sketch_notice">
Check for pending spike/sketch work and surface a notice (does not change routing):

```bash
# Check for pending spikes (verdict: PENDING in any README)
PENDING_SPIKES=$(grep -rl 'verdict: PENDING' .planning/spikes/*/README.md 2>/dev/null | wc -l | tr -d ' ')

# Check for pending sketches (winner: null in any README)
PENDING_SKETCHES=$(grep -rl 'winner: null' .planning/sketches/*/README.md 2>/dev/null | wc -l | tr -d ' ')
```

If either count is > 0, display before routing:
```
⚠ Pending exploratory work:
  {PENDING_SPIKES} spike(s) with unresolved verdicts in .planning/spikes/
  {PENDING_SKETCHES} sketch(es) without a winning variant in .planning/sketches/

  Resume with `/gsd:spike` or `/gsd:sketch`, or continue with phase work below.
```

Only show lines for non-zero counts. If both are 0, skip this notice entirely.
</step>

<step name="determine_next_action">
Apply routing rules based on state:

**Route 1: No phases exist yet → discuss**
If ROADMAP has phases but no phase directories exist on disk:
→ Next action: `/gsd:discuss-phase <first-phase>`

**Route 2: Phase exists but has no CONTEXT.md or RESEARCH.md → discuss**
If the current phase directory exists but has neither CONTEXT.md nor RESEARCH.md:
→ Next action: `/gsd:discuss-phase <current-phase>`

**Route 3: Phase has context but no plans → plan**
If the current phase has CONTEXT.md (or RESEARCH.md) but no PLAN.md files:
→ Next action: `/gsd:plan-phase <current-phase>` (or `/gsd:plan-review-convergence <current-phase>` when `PLAN_STRATEGY=converge`)

**Route 4: Phase has plans but incomplete summaries → execute**
If plans exist but not all have matching summaries:
→ Next action: `/gsd:execute-phase <current-phase>`

**Route 5: All plans have summaries → verify and complete**
If all plans in the current phase have summaries:
→ Next action: `/gsd:verify-work`

**Route 6: Phase complete, next phase exists → advance**
If the current phase is complete and the next phase exists in ROADMAP:
→ Next action: `/gsd:discuss-phase <next-phase>`

**Route 7: All phases complete → complete milestone**
If all phases are complete:
→ Next action: `/gsd:complete-milestone`

**Route 8: Paused → resume**
If STATE.md shows paused_at:
→ Next action: `/gsd:resume-work`
</step>

<step name="show_and_execute">
Parse the arguments passed to this workflow to detect the plan strategy and build convergence pass-through args:

```bash
PLAN_STRATEGY="local"
if echo "$ARGUMENTS" | grep -qE '(^|[[:space:]])\-\-(converge|cross-ai)([[:space:]]|$)'; then
  PLAN_STRATEGY="converge"
fi

CONVERGENCE_ARGS=""
# Lane flags derived from the declared roster (#2800/#2272); --all and --text are convergence
# controls, not reviewer lanes, so they stay literal.
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

If `PLAN_STRATEGY` is `converge`, fail fast unless the convergence feature gate is enabled:

```bash
if [ "$PLAN_STRATEGY" = "converge" ]; then
  CONVERGENCE_ENABLED=$(gsd_run query config-get workflow.plan_review_convergence 2>/dev/null || echo "false")
  if [ "$CONVERGENCE_ENABLED" != "true" ]; then
    printf '%s\n' \
      '/gsd:progress --next --converge is disabled (workflow.plan_review_convergence=false).' \
      '' \
      'Enable plan convergence with:' \
      '' \
      '  gsd config-set workflow.plan_review_convergence true' \
      '' \
      'Then re-run with --converge.'
    exit 1
  fi
fi
```

Display the determination:

```
## GSD Next

**Current:** Phase [N] — [name] | [progress]%
**Status:** [status description]

▶ **Next step:** `/gsd-[command] [args]`
  [One-line explanation of why this is the next step]
```

Then immediately invoke the determined command via SlashCommand.
Do not ask for confirmation — the whole point of `/gsd:progress --next` is zero-friction advancement.

**Route 3 convergence override:** When the routing decision is Route 3 (plan) and `PLAN_STRATEGY=converge`, invoke `/gsd:plan-review-convergence <current-phase> ${CONVERGENCE_ARGS}` instead of `/gsd:plan-phase <current-phase>`.

**If `--auto` was passed:** after the determined command completes, automatically re-invoke `/gsd:progress --next --auto` (forwarding `--converge`/`--cross-ai` and any reviewer flags if they were originally passed) to continue chaining to the next step. Repeat until one of:
- A milestone completes (`/gsd:complete-milestone` is reached)
- A blocking decision is required (safety gate triggers, prior-phase completeness prompt, user input needed)
- An error or paused state is detected

When stopping due to a blocker, display:
```
⛔ Auto-chain stopped: [reason — e.g. safety gate, blocking decision required]

Resume with: `/gsd:progress --next --auto` once resolved.
```
</step>

</process>

<success_criteria>
- [ ] Project state correctly detected
- [ ] Gates 1-3 (repo/state validity) run first — always, even on the resume path
- [ ] Route 0 (resume_incomplete_phase) runs AFTER Gates 1-3 and BEFORE the prior-phase defer prompt — no double-decision in the default (no-flag) case
- [ ] Default (no flag): Route 0 resumes incomplete phase silently, exits — user never sees the prior-phase defer prompt
- [ ] `--no-resume`: Route 0 skipped, prior_phase_completeness defer prompt runs as before
- [ ] `--force`: everything skipped (Gates, Route 0, prior_phase_completeness) → straight to `determine_next_action`
- [ ] Scan uses `gsd_run` (canonical resolver form); errors are surfaced rather than suppressed
- [ ] Predicate is plans-without-summaries (`plans.length > summaries.length`) — consistent with `determine_next_action` Route 4
- [ ] Next action correctly determined from routing rules
- [ ] Command invoked immediately without user confirmation
- [ ] Clear status shown before invoking
- [ ] `--converge` routes Route 3 planning through `gsd-plan-review-convergence`
- [ ] `--cross-ai` is accepted as an alias for `--converge`
- [ ] `--converge` fails fast with enable instructions when `workflow.plan_review_convergence=false`
- [ ] `--converge` forwards reviewer selector flags and `--max-cycles N`
- [ ] Default planning remains `gsd-plan-phase` when convergence is not requested
</success_criteria>

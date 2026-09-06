@~/.claude/gsd-core/references/response-language-directive.md

<internal_workflow>

**This is an INTERNAL workflow — NOT a user-facing command.**

There is no `/gsd-transition` command. This workflow is invoked automatically by
`execute-phase` during auto-advance, or inline by the orchestrator after phase
verification. Users should never be told to run `/gsd-transition`.

**Valid user commands for phase progression:**
- `/gsd:discuss-phase {N}` — discuss a phase before planning
- `/gsd:plan-phase {N}` — plan a phase
- `/gsd:execute-phase {N}` — execute a phase
- `/gsd:progress` — see roadmap progress

</internal_workflow>

<required_reading>

**Read these files NOW:**

1. `.planning/STATE.md`
2. `.planning/PROJECT.md`
3. `.planning/ROADMAP.md`
4. Current phase's plan files (`*-PLAN.md`)
5. Current phase's summary files (`*-SUMMARY.md`)

</required_reading>

<purpose>

Mark current phase complete and advance to next. This is the natural point where progress tracking and PROJECT.md evolution happen.

"Planning next phase" = "current phase is done"

</purpose>

<process>

<step name="post_completion_mode" priority="first">

**Invocation mode — read this FIRST.** This workflow runs two ways:

1. **Standalone transition** (normal path): the phase is being marked complete AND
   transitioned by this workflow. Run EVERY step below in order — `verify_completion`,
   `update_roadmap_and_state` (which calls `gsd_run query phase.complete`), then the
   post-processing.

2. **Post-completion delegation** (invoked by `execute-phase` after its auto-chain
   completion — #1526): `phase.complete` was already called by execute-phase's
   `update_roadmap` step and verification already passed in execute-phase's
   `verify_phase_goal`. SKIP `verify_completion` and `update_roadmap_and_state`
   (re-running `phase.complete` would double-write STATE.md/ROADMAP.md). Run
   `cleanup_handoff` (stale `.continue-here` handoffs are still cleared post-completion),
   then BEGIN at `evolve_project` and run every step from there through
   `offer_next_phase` (this is the post-processing parity set: graduation scan,
   session-continuity, project-reference, accumulated-context, current-position/progress).
   `archive_prompts` is a documented no-op in either mode.

Detect post-completion mode when the caller states that phase completion and
verification have already run. When in doubt, run standalone (mode 1) — it is
idempotent enough to be safe, just slower.
</step>

<step name="load_project_state" priority="first">

Before transition, read project state:

```bash
cat .planning/STATE.md 2>/dev/null || true
cat .planning/PROJECT.md 2>/dev/null || true
```

Parse current position to verify we're transitioning the right phase.
Note accumulated context that may need updating after transition.

</step>

<step name="verify_completion">

Check current phase has all plan summaries:

```bash
(ls .planning/phases/XX-current/*-PLAN.md 2>/dev/null || true) | sort
(ls .planning/phases/XX-current/*-SUMMARY.md 2>/dev/null || true) | sort
```

**Verification logic:**

- Count PLAN files
- Count SUMMARY files
- If counts match: all plans complete
- If counts don't match: incomplete

<config-check>

```bash
cat .planning/config.json 2>/dev/null || true
```

</config-check>

**Check for verification debt in this phase:**

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# #3492: resolve THIS phase's own report through the single shared seam
# (src/verification.cts resolveVerificationFile) instead of a blind
# `*-VERIFICATION.md` glob — a stray ad-hoc worksheet (e.g.
# `03-CORRECTION-VERIFICATION.md`) alphabetically outranks the real report
# and previously fed this awk parse the wrong file.
VERIFICATION_FILE=$(gsd_run query verification.resolve-file .planning/phases/XX-current --raw 2>/dev/null)
# awk extracts only the status: field between the two --- fences to avoid
# false positives from historical body text (e.g. previous_status: gaps_found).
# FNR (not NR) re-arms the frontmatter scan per input file: NR only ever arms
# on the very FIRST line of the very first file, so a multi-file input would
# silently read empty status for every file after the first. The resolver
# above always hands back a single path, but the parse stays correct even if
# that ever changes.
VERIFY_STATUS=$(awk 'FNR==1&&/^---$/{in_fm=1;next}in_fm&&/^---$/{exit}in_fm&&/^status: /{print $2}' \
  "$VERIFICATION_FILE" 2>/dev/null | head -1)
```

**If VERIFY_STATUS is not `passed`:**

Stop before confirming:

```
Verification incomplete: ${VERIFY_STATUS:-missing}

Resolve before transition. Review: `/gsd:audit-uat`
```

This preliminary check blocks obviously unresolved verification early, ahead
of the authoritative gate below. `gsd_run query phase.complete` (in
`update_roadmap_and_state`) remains the authoritative stale-aware gate and
fail-closes unless canonical verification status is `passed`.

**If all plans complete:**

<if mode="yolo">

```
⚡ Auto-approved: Transition Phase [X] → Phase [X+1]
Phase [X] complete — all [Y] plans finished.

Proceeding to mark done and advance...
```

Proceed directly to cleanup_handoff step.

</if>

<if mode="interactive" OR="custom with gates.confirm_transition true">

Ask: "Phase [X] complete — all [Y] plans finished. Ready to mark done and move to Phase [X+1]?"

Wait for confirmation before proceeding.

</if>

**If plans incomplete:**

**SAFETY RAIL: always_confirm_destructive applies here.**
Skipping incomplete plans is destructive — ALWAYS prompt regardless of mode.

Present:

```
Phase [X] has incomplete plans:
- {phase}-01-SUMMARY.md ✓ Complete
- {phase}-02-SUMMARY.md ✗ Missing
- {phase}-03-SUMMARY.md ✗ Missing

⚠️ Safety rail: Skipping plans requires confirmation (destructive action)

Options:
1. Continue current phase (execute remaining plans)
2. Mark complete anyway (skip remaining plans)
3. Review what's left
```

Wait for user decision.

</step>

<step name="cleanup_handoff">

Check for lingering handoffs:

```bash
ls .planning/phases/XX-current/.continue-here*.md 2>/dev/null || true
```

If found, delete them — phase is complete, handoffs are stale.

</step>

<step name="update_roadmap_and_state">

**Delegate ROADMAP.md and STATE.md updates to `gsd_run query phase.complete`:**

```bash
TRANSITION=$(gsd_run query phase.complete "${current_phase}")
```

The CLI handles:
- Marking the phase checkbox as `[x]` complete with today's date
- Updating plan count to final (e.g., "3/3 plans complete")
- Updating the Progress table (Status → Complete, adding date)
- Advancing STATE.md to next phase (Current Phase, Status → Ready to plan, Current Plan → Not started)
- Detecting if this is the last phase in the milestone

Extract from result: `completed_phase`, `plans_executed`, `next_phase`, `next_phase_name`, `is_last_phase`.

</step>

<step name="archive_prompts">

If prompts were generated for the phase, they stay in place.
The `completed/` subfolder pattern from create-meta-prompts handles archival.

</step>

<step name="evolve_project">

Evolve PROJECT.md to reflect learnings from completed phase.

**Read phase summaries:**

```bash
_SUMMARIES=( .planning/phases/XX-current/*-SUMMARY.md )
if [ -e "${_SUMMARIES[0]}" ]; then cat "${_SUMMARIES[@]}"; fi
```

**Assess requirement changes:**

1. **Requirements validated?**
   - Any Active requirements shipped in this phase?
   - Move to Validated with phase reference: `- ✓ [Requirement] — Phase X`

2. **Requirements invalidated?**
   - Any Active requirements discovered to be unnecessary or wrong?
   - Move to Out of Scope with reason: `- [Requirement] — [why invalidated]`

3. **Requirements emerged?**
   - Any new requirements discovered during building?
   - Add to Active: `- [ ] [New requirement]`

4. **Decisions to log?**
   - Extract decisions from SUMMARY.md files
   - Add to Key Decisions table with outcome if known

5. **"What This Is" still accurate?**
   - If the product has meaningfully changed, update the description
   - Keep it current and accurate

**Update PROJECT.md:**

Make the edits inline. Update "Last updated" footer:

```markdown
---
*Last updated: [date] after Phase [X]*
```

**Example evolution:**

Before:

```markdown
### Active

- [ ] JWT authentication
- [ ] Real-time sync < 500ms
- [ ] Offline mode

### Out of Scope

- OAuth2 — complexity not needed for v1
```

After (Phase 2 shipped JWT auth, discovered rate limiting needed):

```markdown
### Validated

- ✓ JWT authentication — Phase 2

### Active

- [ ] Real-time sync < 500ms
- [ ] Offline mode
- [ ] Rate limiting on sync endpoint

### Out of Scope

- OAuth2 — complexity not needed for v1
```

**Step complete when:**

- [ ] Phase summaries reviewed for learnings
- [ ] Validated requirements moved from Active
- [ ] Invalidated requirements moved to Out of Scope with reason
- [ ] Emerged requirements added to Active
- [ ] New decisions logged with rationale
- [ ] "What This Is" updated if product changed
- [ ] "Last updated" footer reflects this transition

</step>

<step name="graduation_scan">

Scan LEARNINGS.md files from recent phases for recurring patterns and surface promotion candidates to the developer.

**Invoke the graduation helper:**

```text
@~/.claude/gsd-core/workflows/graduation.md
```

This step is fully delegated to `graduation.md`. It handles guard checks (feature flag, window size, threshold), clustering, backlog filtering, HITL prompting, promotion writes, and STATE.md updates.

**This step is always non-blocking:** graduation candidates are surfaced for the developer's decision; no action is required to continue the transition. If the graduation scan produces no qualifying clusters, it prints a single `[graduation: no qualifying clusters]` line and returns.

**Step complete when:**

- [ ] graduation.md guard checks passed (or skipped with silent no-op)
- [ ] Recurring clusters surfaced (or `[graduation: no qualifying clusters]` printed)
- [ ] Each cluster resolved as Promote / Defer / Dismiss (or all skipped)

</step>

<step name="update_current_position_after_transition">

**Note:** Basic position updates (Current Phase, Status, Current Plan, Last Activity) were already handled by `gsd_run query phase.complete` in the update_roadmap_and_state step.

Verify the updates are correct by reading STATE.md. If the progress bar needs updating, use:

```bash
PROGRESS=$(gsd_run query progress.bar --raw)
```

Update the progress bar line in STATE.md with the result.

**Step complete when:**

- [ ] Phase number incremented to next phase (done by phase complete)
- [ ] Plan status reset to "Not started" (done by phase complete)
- [ ] Status shows "Ready to plan" (done by phase complete)
- [ ] Progress bar reflects total completed plans

</step>

<step name="update_project_reference">

Update Project Reference section in STATE.md.

```markdown
## Project Reference

See: .planning/PROJECT.md (updated [today])

**Core value:** [Current core value from PROJECT.md]
**Current focus:** [Next phase name]
```

Update the date and current focus to reflect the transition.

</step>

<step name="review_accumulated_context">

Review and update Accumulated Context section in STATE.md.

**Decisions:**

- Note recent decisions from this phase (3-5 max)
- Full log lives in PROJECT.md Key Decisions table

**Blockers/Concerns:**

- Review blockers from completed phase
- If addressed in this phase: Remove from list
- If still relevant for future: Keep with "Phase X" prefix
- Add any new concerns from completed phase's summaries

**Example:**

Before:

```markdown
### Blockers/Concerns

- ⚠️ [Phase 1] Database schema not indexed for common queries
- ⚠️ [Phase 2] WebSocket reconnection behavior on flaky networks unknown
```

After (if database indexing was addressed in Phase 2):

```markdown
### Blockers/Concerns

- ⚠️ [Phase 2] WebSocket reconnection behavior on flaky networks unknown
```

**Step complete when:**

- [ ] Recent decisions noted (full log in PROJECT.md)
- [ ] Resolved blockers removed from list
- [ ] Unresolved blockers kept with phase prefix
- [ ] New concerns from completed phase added

</step>

<step name="update_session_continuity_after_transition">

Update Session Continuity section in STATE.md to reflect transition completion.

**Format:**

```markdown
Last session: [today]
Stopped at: Phase [X] complete, ready to plan Phase [X+1]
Resume file: None
```

**Step complete when:**

- [ ] Last session timestamp updated to current date and time
- [ ] Stopped at describes phase completion and next phase
- [ ] Resume file confirmed as None (transitions don't use resume files)

</step>

<step name="offer_next_phase">

**MANDATORY: Verify milestone status before presenting next steps.**

**Use the transition result from `gsd_run query phase.complete`:**

The `is_last_phase` field from the phase complete result tells you directly:
- `is_last_phase: false` → More phases remain → Go to **Route A**
- `is_last_phase: true` → Last phase done → **Check for workstream collisions first**

The `next_phase` and `next_phase_name` fields give you the next phase details.

If you need additional context, use:
```bash
ROADMAP=$(gsd_run query roadmap.analyze)
```

This returns all phases with goals, disk status, and completion info.

**Section-manifest gate (#2994):** `gsd_run` is already established above (`verify_completion` step) — fetch the dedicated `init.transition` bundle for the workstream-collision-check gate below:

```bash
INIT_TRANSITION=$(gsd_run query init.transition)
if [[ "$INIT_TRANSITION" == @file:* ]]; then INIT_TRANSITION=$(cat "${INIT_TRANSITION#@file:}"); fi
```

Extract from `INIT_TRANSITION`: `other_active_workstreams`, `section_manifest`.

---

<!-- gsd:section id="workstream-collision-check" when="state:workstream-active" -->
If `section_manifest` (from `INIT_TRANSITION`) is `null` or `"workstream-collision-check"` is in its `included` list: read and execute `gsd-core/workflows/transition/steps/workstream-collision-check.md`. Otherwise (flat mode) skip — do not read the file; go directly to **Route B**.
<!-- /gsd:section -->

---

**Route A: More phases remain in milestone**

Read ROADMAP.md to get the next phase's name and goal.

**Check if next phase has CONTEXT.md:**

```bash
ls .planning/phases/*[X+1]*/*-CONTEXT.md 2>/dev/null || true
```

**If next phase exists:**

<if mode="yolo">

**If CONTEXT.md exists:**

```
Phase [X] marked complete.

Next: Phase [X+1] — [Name]

⚡ Auto-continuing: Plan Phase [X+1] in detail
```

Exit skill and invoke SlashCommand("/gsd:plan-phase [X+1] --auto ${GSD_WS}")

**If CONTEXT.md does NOT exist:**

```
Phase [X] marked complete.

Next: Phase [X+1] — [Name]

⚡ Auto-continuing: Discuss Phase [X+1] first
```

Exit skill and invoke SlashCommand("/gsd:discuss-phase [X+1] --auto ${GSD_WS}")

</if>

<if mode="interactive" OR="custom with gates.confirm_transition true">

**If CONTEXT.md does NOT exist:**

```
## ✓ Phase [X] Complete

---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Phase [X+1]: [Name]** — [Goal from ROADMAP.md]

`/clear` then:

`/gsd:discuss-phase [X+1] ${GSD_WS}` — gather context and clarify approach

---

**Also available:**
- `/gsd:plan-phase [X+1] ${GSD_WS}` — skip discussion, plan directly
- `/gsd:plan-phase --research-phase [X+1] ${GSD_WS}` — investigate unknowns

---
```

**If CONTEXT.md exists:**

```
## ✓ Phase [X] Complete

---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Phase [X+1]: [Name]** — [Goal from ROADMAP.md]
<sub>✓ Context gathered, ready to plan</sub>

`/clear` then:

`/gsd:plan-phase [X+1] ${GSD_WS}`

---

**Also available:**
- `/gsd:discuss-phase [X+1] ${GSD_WS}` — revisit context
- `/gsd:plan-phase --research-phase [X+1] ${GSD_WS}` — investigate unknowns

---
```

</if>

---

**Route B1: Workstream done, other workstreams still active**

This route is reached when `is_last_phase: true` AND the collision check found
other active workstreams. Do NOT suggest completing the milestone or advancing
to the next milestone — other workstreams are still working.

**Clear auto-advance chain flag** — workstream boundary is the natural stopping point:

```bash
gsd_run query config-set workflow._auto_chain_active false
```

<if mode="yolo">

Override auto-advance: do NOT auto-continue to milestone completion.
Present the blocking information and stop.

</if>

Present (all modes):

```
## ✓ Phase {X}: {Phase Name} Complete

This workstream's phases are complete. Other workstreams are still active:

| Workstream | Status | Phase | Progress |
|------------|--------|-------|----------|
| {name}     | {status} | {current_phase} | {completed_phases}/{phase_count} |
| ...        | ...    | ...   | ...      |

---

## Next Steps

Archive this workstream:

`/gsd:workstreams complete {current_ws_name} ${GSD_WS}`

See overall milestone progress:

`/gsd:workstreams progress ${GSD_WS}`

<sub>Milestone completion will be available once all workstreams finish.</sub>

---
```

Do NOT suggest `/gsd:complete-milestone` or `/gsd:new-milestone`.
Do NOT auto-invoke any further slash commands.

**Stop here.** The user must explicitly decide what to do next.

---

**Route B: All phases complete (milestone ready to close)**

**This route is only reached when:**
- `is_last_phase: true` AND no other active workstreams exist (or flat mode)

**Clear auto-advance chain flag** — milestone boundary is the natural stopping point:

```bash
gsd_run query config-set workflow._auto_chain_active false
```

<if mode="yolo">

```
Phase {X} marked complete.

🎉 Milestone {version} is 100% complete — all {N} phases finished!

⚡ Auto-continuing: Complete milestone and archive
```

Exit skill and invoke SlashCommand("/gsd:complete-milestone {version} ${GSD_WS}")

</if>

<if mode="interactive" OR="custom with gates.confirm_transition true">

```
## ✓ Phase {X}: {Phase Name} Complete

🎉 Milestone {version} is 100% complete — all {N} phases finished!

---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Complete Milestone {version}** — archive and prepare for next

`/clear` then:

`/gsd:complete-milestone {version} ${GSD_WS}`

---

**Also available:**
- Review accomplishments before archiving

---
```

</if>

</step>

</process>

<implicit_tracking>
Progress tracking is IMPLICIT: planning phase N implies phases 1-(N-1) complete. No separate progress step—forward motion IS progress.
</implicit_tracking>

<partial_completion>

If user wants to move on but phase isn't fully complete:

```
Phase [X] has incomplete plans:
- {phase}-02-PLAN.md (not executed)
- {phase}-03-PLAN.md (not executed)

Options:
1. Mark complete anyway (plans weren't needed)
2. Defer work to later phase
3. Stay and finish current phase
```

Respect user judgment — they know if work matters.

**If marking complete with incomplete plans:**

- Update ROADMAP: "2/3 plans complete" (not "3/3")
- Note in transition message which plans were skipped

</partial_completion>

<success_criteria>

Transition is complete when:

- [ ] Current phase plan summaries verified (all exist or user chose to skip)
- [ ] Any stale handoffs deleted
- [ ] ROADMAP.md updated with completion status and plan count
- [ ] PROJECT.md evolved (requirements, decisions, description if needed)
- [ ] STATE.md updated (position, project reference, context, session)
- [ ] Progress table updated
- [ ] User knows next steps

</success_criteria>

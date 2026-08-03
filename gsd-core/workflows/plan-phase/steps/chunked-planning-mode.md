## 8.5. Chunked Planning Mode

**Skip if `CHUNKED_MODE` is `false`.**

Chunked mode splits the single planner run into a short outline run + N short per-plan
runs (~3–5 min each), committing each plan individually for crash resilience. Rerunning
`/gsd:plan-phase {N} --chunked` resumes from the last committed plan.

For recovering plans from a prior *non-chunked* run, use step 6's "Add more plans" or
proceed to `/gsd:execute-phase` — don't start a fresh chunked run over them.

### 8.5.1 Outline Phase (outline-only mode, ~2 min)

**Resume detection:** If `${PHASE_DIR}/${PADDED_PHASE}-PLAN-OUTLINE.md` exists and contains
the `## OUTLINE COMPLETE` marker (written by the outline agent — #2762), skip to 8.5.2.

```bash
OUTLINE_FILE="${PHASE_DIR}/${PADDED_PHASE}-PLAN-OUTLINE.md"
if [[ -f "$OUTLINE_FILE" ]] && grep -q "^## OUTLINE COMPLETE" "$OUTLINE_FILE"; then
  # reuse existing outline — skip to 8.5.2
fi
```

Display:
```text
◆ Chunked mode: spawning outline planner... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Spawn the planner in **outline-only** mode — it must write only the outline manifest, not any
PLAN.md files:

```javascript
Agent(
  prompt="{same planning_context as step 8, plus:}

  **Chunked mode: outline-only.**
  Do NOT write any PLAN.md files in this Task.
  Write only: {PHASE_DIR}/{PADDED_PHASE}-PLAN-OUTLINE.md

  The outline must be a markdown table with columns:
  Plan ID | Objective | Wave | Depends On | Requirements

  End the file with a final line `## OUTLINE COMPLETE` — §8.5.1's resume-check greps
  the file for it, so it MUST be written here, not just returned.
  Return: ## OUTLINE COMPLETE with plan count.",
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Outline Phase {phase} (chunked)"
)
```

> **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

Handle return:
- **`## OUTLINE COMPLETE`:** Read `PLAN-OUTLINE.md`, extract plan list. Continue to 8.5.2.
- **Any other return or empty:** Display error. Offer: 1) Retry outline, 2) Stop.

### 8.5.2 Per-Plan Tasks (single-plan mode, ~3-5 min each)

For each plan entry extracted from `PLAN-OUTLINE.md`:

1. **Resume check:** Skip if `${PHASE_DIR}/{plan_id}-PLAN.md` exists with valid frontmatter
   (resume safety) — UNLESS `--reviews` is set, whose purpose is to REPLAN with review
   feedback (§6), so existing plans are overwritten, not skipped (#2762).

   ```bash
   PLAN_FILE="${PHASE_DIR}/${plan_id}-PLAN.md"
   if [[ -f "$PLAN_FILE" ]] && head -1 "$PLAN_FILE" | grep -q '^---' && [[ "$ARGUMENTS" != *"--reviews"* ]]; then
     continue  # resume safety — NOT under --reviews (replan)
   fi
   ```

2. Display:
   ```text
   ◆ Chunked mode: planning {plan_id} ({k}/{N})... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
   ```

3. Spawn the planner in **single-plan** mode — it must write exactly one PLAN.md file:
   ```javascript
   Agent(
     prompt="{same planning_context as step 8, plus:}

     **Chunked mode: single-plan.**
     Write exactly ONE plan file: {PHASE_DIR}/{plan_id}-PLAN.md
     Plan to write: {plan_id} — {objective}
     Wave: {wave} | Depends on: {depends_on}
     Phase requirement IDs to cover in this plan: {plan_requirements}

     Return: ## PLAN COMPLETE with the plan ID.",
     subagent_type="gsd-planner",
     model="{planner_model}",
     description="Plan {plan_id} (chunked {k}/{N})"
   )
   ```

   > **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

4. **Verify disk:** Check `${PHASE_DIR}/{plan_id}-PLAN.md` exists. If missing: offer 1) Retry, 2) Stop.

5. **Commit per-plan:**
   ```bash
   gsd_run query commit "docs(${PADDED_PHASE}): plan ${plan_id} (chunked)" --files "${PHASE_DIR}/${plan_id}-PLAN.md"
   ```

After all N plans are written and committed, treat this as `## PLANNING COMPLETE` and continue
to step 9.


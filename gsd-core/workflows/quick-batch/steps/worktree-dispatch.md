**Step 6: Worktree create + executor dispatch**

This is the batch's MUTATING wave — worktree create/executor dispatch/merge
are the operations `isolation == "none"` caps to concurrency 1 (row 6),
unlike planning/research above.

**Auto-degrade on stale fork base (row 38, mirrors `/gsd:quick`'s own #1941
guard):**
```bash
if [ "$ISOLATION" = "harness-worktree" ] && [ "${USE_WORKTREES:-true}" != "false" ]; then
  _QB_SHOULD_DEGRADE=$(gsd_run query worktree.base-check --mode "$ISOLATION" --pick shouldDegrade 2>/dev/null || true)
  if [ "$_QB_SHOULD_DEGRADE" = "true" ]; then
    echo "⚠ [#1941] Worktree fork base diverged — auto-degrading quick-batch to sequential mode." >&2
    USE_WORKTREES=false
    ISOLATION=none
  fi
fi
gsd_run query dispatch-isolation --raw --force-isolation "$ISOLATION" >/dev/null 2>&1 || true
```

**Effective concurrency for this MUTATING wave** (`mutating` forces
`isolation == none` to 1 regardless of `--jobs`/capacity — row 6):
```bash
QB_EXEC_CONC_JSON=$(gsd_run quick-batch effective-concurrency --jobs "$JOBS" --task-count "$ITEM_COUNT" --capacity "$CAPACITY" --isolation "$ISOLATION" --mutating --raw)
EXEC_CONCURRENCY=$(printf '%s' "$QB_EXEC_CONC_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.concurrency))}catch{process.stdout.write("1")}})')
```

**Dispatch rounds.** Repeat until no item is eligible-and-not-yet-dispatched
(bounded by `$ITEM_COUNT` rounds):

1. Re-derive eligibility (also reconciles crash-window/blocked-propagation —
   safe to call repeatedly, idempotent when nothing changed):
   ```bash
   QB_ELIG_JSON=$(gsd_run quick-batch resume --batch "$BATCH_ID" --raw)
   ```
   Parse `eligible` (quick ids ready to execute — every dependency already
   `complete`) and refresh `$BATCH_MANIFEST_JSON` from its `manifest`.

2. **Backpressure.** Not every eligible item necessarily spawns this round —
   cap fan-out at `$EXEC_CONCURRENCY` minus current in-flight count (row
   27/39):
   ```bash
   QB_SPAWN_JSON=$(gsd_run quick-batch spawn-plan --eligible "$ELIGIBLE_IDS_JSON" --capacity "$EXEC_CONCURRENCY" --in-flight "$IN_FLIGHT_COUNT" --raw)
   ```
   Parse `spawn` (dispatch these now) and `pending` (leave `pending` in
   `BATCH.json` — already the case, no write needed; NEVER mark these
   `failed`, NEVER increase fan-out to compensate).

3. **Create worktrees + dispatch executors, ONE AT A TIME per `spawn` item**
   (`git worktree add` races on `.git/config.lock` — never simultaneous,
   `execute-phase.md`'s own discipline):

   For each item in `spawn`, in order:

   ```bash
   SLUG=$(gsd_run query generate-slug "$description" --raw)
   ITEM_DIR="${quick_dir}/${quick_id}-${SLUG}"
   ```

   **`isolation == "harness-worktree"`:** one `Agent()` per message,
   `run_in_background: true`. Same prompt shape as `/gsd:quick`'s own
   executor dispatch (Step 6 of `quick.md`) — required_reading, agent skills,
   `<submodule_commit_guard>` using this project's `$SUBMODULE_PATHS`
   (identical block, verbatim) — with these differences:
   ```
   Agent(
     prompt="
   Execute quick-batch item ${quick_id}.

   <required_reading>
   - ${ITEM_DIR}/${quick_id}-PLAN.md (Plan)
   - ${STATE_PATH} (Project state — READ ONLY, do not write it)
   - ./CLAUDE.md or ./.claude/CLAUDE.md (if exists)
   </required_reading>

   ${AGENT_SKILLS_EXECUTOR}

   <submodule_commit_guard>
   (same SUBMODULE_PATHS fail-loud guard as /gsd:quick — see gsd-core/workflows/quick.md Step 6)
   </submodule_commit_guard>

   <constraints>
   - Execute all tasks in the plan; commit each task atomically
   - Create summary at: ${ITEM_DIR}/${quick_id}-SUMMARY.md with `status: complete` in frontmatter
   - NEVER invoke /gsd:quick or any other GSD command — you are a leaf, not a coordinator
   - NEVER write .planning/quick-batches/${BATCH_ID}/BATCH.json
   - Do NOT update STATE.md or ROADMAP.md — the orchestrator owns those writes after every item in this dispatch round completes (ADR-1239 single-writer invariant)
   - Do NOT commit docs artifacts (SUMMARY.md, STATE.md, PLAN.md) — the orchestrator commits them at completion
   </constraints>
   ",
     subagent_type="gsd-executor",
     model="{executor_model}",
     {harnessFlag}
     description="Execute ${quick_id}: ${description}"
   )
   ```
   Record `{agent_id, worktree_path, branch, expected_base, allowed_bases}`
   from the executor's return into `$QUICK_BATCH_WORKTREE_MANIFEST` (a JSON
   file, initialized `{"worktrees":[]}` before the first round — same shape
   `/gsd:quick`'s own `QUICK_WORKTREE_MANIFEST` uses).

   **`isolation == "orchestrator-worktree"`:** GSD creates the worktree
   (`gsd_run query worktree.create --manifest "$QUICK_BATCH_WORKTREE_MANIFEST" --agent-id ... --path ... --branch ... --base ... --files "$PLAN_FILES" --deletions "$PLAN_DELETIONS"`) then
   process-spawns the executor via `dispatch-isolation --json --cwd-target
   --prompt`, exactly as `gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md`'s
   "orchestrator-worktree" section
   describes — reuse that mechanism verbatim, substituting this item's
   `${quick_id}`/`${ITEM_DIR}`/`${quick_id}-PLAN.md` for its
   `{plan_number}`/`{phase_dir}`/`{plan_file}` placeholders.

   **`isolation == "none"`:** no worktree. Dispatch the executor inline on the
   primary checkout (same prompt, minus the worktree-only framing), one item
   at a time — `EXEC_CONCURRENCY` is already forced to 1 in this mode.

   > **ORCHESTRATOR RULE — CODEX RUNTIME**: after each `Agent()` call above, wait for it to return before starting the next worktree create.

4. **After every item dispatched this round returns:** verify
   `${ITEM_DIR}/${quick_id}-SUMMARY.md` exists. If missing, the item stays
   `pending`/its worktree preserved for diagnosis rather than guessing
   completion — do not proceed to merge for it this round.

Continue to Step 7 once every eligible item has been dispatched (across
however many rounds backpressure required) and returned.

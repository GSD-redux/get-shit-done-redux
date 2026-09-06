**Step 6: Worktree create + executor dispatch**

This is the batch's MUTATING wave — worktree create/executor dispatch/merge
are the operations `isolation == "none"` caps to concurrency 1 (row 6),
unlike planning/research above.

**Auto-degrade on stale fork base (row 38, mirrors `/gsd:quick`'s own #1941
guard):**
```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
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

   **Crash-window guard (mirrors `planner-wave.md`'s PLAN.md-existence
   check one layer earlier — #3677):** `quick-batch resume`'s `eligible` is
   purely status/dependency-derived; it does NOT know an item already
   finished executing. A coordinator crash between this step returning
   (executor committed, `SUMMARY.md` written) and Step 7's merge leaves
   `BATCH.json` at `pending` with no STATE.md row yet (that row is written
   only in Step 9) — so on `--resume`, such an item still comes back
   `eligible` here. Before computing `spawn-plan`, determine which eligible
   items already have `${item_dir}/${quick_id}-SUMMARY.md` on disk (same
   `item_dir` derivation via `generate-slug` every other step uses), then
   let the PURE `quick-batch filter-executed` verb
   (`filterAlreadyExecuted`, `src/quick-batch-dispatch.cts`) decide which
   ids are actually safe to spawn — never re-derive that split inline:
   ```bash
   EXECUTED_IDS_JSON="[]" # JSON array of quick_ids whose SUMMARY.md already exists on disk this round
   QB_FILTER_JSON=$(gsd_run quick-batch filter-executed --eligible "$ELIGIBLE_IDS_JSON" --executed "$EXECUTED_IDS_JSON" --raw)
   ```
   Parse `spawnEligible` (safe to spawn this round) and `alreadyExecuted`
   (diagnostic only — report these as "already executed, routing to merge"
   rather than dispatching them). Replace `$ELIGIBLE_IDS_JSON` with
   `spawnEligible` before continuing to backpressure below.

   NEVER re-dispatch it into a second worktree for any id `filter-executed`
   returns in `alreadyExecuted`. It is not lost: Step 7's own mergeable-wave
   criterion
   (`gsd-core/workflows/quick-batch/steps/merge-wave.md` Step 1) already
   picks up any `pending` item with an on-disk `SUMMARY.md` that isn't yet
   merged, independent of this eligible/spawn list — dropping it here only
   prevents the duplicate dispatch, it does not remove it from the batch.

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

   **Durable worktree-recovery persistence (#3677 — `harness-worktree`/
   `orchestrator-worktree` only, skip for `none`):** immediately after
   recording `{agent_id, worktree_path, branch, expected_base}` into the
   EPHEMERAL `$QUICK_BATCH_WORKTREE_MANIFEST` above, ALSO persist the same
   triple durably onto this item in `BATCH.json`:
   ```bash
   gsd_run quick-batch update --batch "$BATCH_ID" --updates '[{"quickId":"'"$quick_id"'","dispatchedWorktree":"'"$worktree_path"'","dispatchedBranch":"'"$branch"'","dispatchedBase":"'"$expected_base"'"}]'
   ```
   The ephemeral manifest is a per-process `mktemp` file (same shape
   `/gsd:quick`'s own `QUICK_WORKTREE_MANIFEST` uses) — it does NOT survive
   a coordinator crash/restart. A RESUMED coordinator's Step 7
   (`merge-wave.md`) reads this durable BATCH.json triple as its fallback
   for any item the crash-window guard above correctly did NOT re-dispatch
   in the current process.

   > **ORCHESTRATOR RULE — CODEX RUNTIME**: after each `Agent()` call above, wait for it to return before starting the next worktree create.

4. **After every item dispatched this round returns:** verify
   `${ITEM_DIR}/${quick_id}-SUMMARY.md` exists. If missing, the item stays
   `pending`/its worktree preserved for diagnosis rather than guessing
   completion — do not proceed to merge for it this round.

Continue to Step 7 once every eligible item has been dispatched (across
however many rounds backpressure required) and returned.

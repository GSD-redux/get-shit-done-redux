**Step 7: Deterministic merge**

Skip entirely if `$ISOLATION == "none"` — nothing was worktree-isolated,
there is nothing to merge (executors already committed to the primary
checkout in Step 6).

**Merge rounds.** Repeat until no wave has a mergeable prefix left (bounded
by `$ITEM_COUNT` rounds):

1. For each DISTINCT `wave` value present among items that are
   `status == "pending"` with a `${item_dir}/${quick_id}-SUMMARY.md` on disk
   (executor returned) and NOT yet merged: build `$WAVE_ORDER_JSON` — the
   `quick_id`s of every item AT THAT WAVE, in `$BATCH_MANIFEST_JSON.items`
   array order (this IS the order `computeWaves`/`partitionByFileOverlap`
   assigned — never re-sort it).

2. Build `$READY_JSON` — the subset of that wave's items whose
   `SUMMARY.md` already exists (an executor may still be mid-flight for a
   sibling in the same wave; row 33 — merges happen strictly in wave order,
   an out-of-order finisher waits):
   ```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
   QB_MERGE_ELIG_JSON=$(gsd_run quick-batch merge-eligible --wave-order "$WAVE_ORDER_JSON" --ready "$READY_JSON" --raw)
   ```
   Parse `mergeable` — the PREFIX of `$WAVE_ORDER_JSON` currently mergeable.
   If empty, skip this wave this round (its first item hasn't finished yet).

3. **Build the cleanup-wave manifest for `mergeable`, IN THAT ORDER** — fresh
   from each item's own PLAN.md, never from `BATCH.json`'s `planned_files`
   alone (Open Question 2's accepted resolution). `$mergeable` is a bash
   ARRAY (parsed from the JSON `mergeable` array) — never a plain
   space-joined string, which re-splits unpredictably between bash and zsh
   (#4109):
   ```bash
   for quick_id in "${mergeable[@]}"; do
     PLAN_CONTENT=$(cat "${ITEM_DIR}/${quick_id}-PLAN.md")
     ENTRY_JSON=$(gsd_run quick-batch cleanup-entry \
       --agent-id "agent-${quick_id}" \
       --worktree-path "$WT_PATH" \
       --branch "$WT_BRANCH" \
       --expected-base "$EXPECTED_BASE" \
       --allowed-bases '["'"$EXPECTED_BASE"'"]' \
       --plan-content "$PLAN_CONTENT" --raw)
     # append $ENTRY_JSON to the merge manifest's "entries" array, in order
   done
   ```
   (`$WT_PATH`/`$WT_BRANCH`/`$EXPECTED_BASE` per item come from the recorded
   `$QUICK_BATCH_WORKTREE_MANIFEST` entry Step 6 wrote for that `agent_id`
   THIS process, when present.

   **Durable fallback (#3677):** for an item Step 6 did NOT dispatch this
   process — the crash-window guard correctly skipped it because
   `SUMMARY.md` already existed from a PRIOR, now-dead coordinator process —
   `$QUICK_BATCH_WORKTREE_MANIFEST` has no entry for it at all (it is a
   fresh per-process `mktemp` file). Read `$WT_PATH`/`$WT_BRANCH`/
   `$EXPECTED_BASE` from that item's OWN durable
   `dispatched_worktree`/`dispatched_branch`/`dispatched_base` fields in
   `$BATCH_MANIFEST_JSON` instead — persisted by Step 6's own durable-
   persistence step at the time it actually created the worktree, in
   whichever process that was. If ALL THREE are still `null` (the item was
   never durably recorded — should not happen once Step 6 always persists
   on dispatch, but fail closed rather than guess): route this entry via
   `merge-routing --kind merge_failed --detail "missing durable worktree
   record"` the same as any other blocked entry below, and do NOT attempt
   the cleanup-wave call for it.)

4. **Merge, one at a time, via the SAME bounded primitive every other worktree
   consumer uses** (never hand-roll `git merge`):
   ```bash
   QB_CLEANUP_RESULT=$(gsd_run query worktree.cleanup-wave --manifest "$MERGE_MANIFEST_PATH" --raw) || true
   ```
   `executeWorktreeWaveCleanupPlan` isolates each entry's failure by default
   (a blocked entry does not stop the rest of the manifest) except the one
   carve-out where the repo is left genuinely mid-merge, which halts the
   remaining entries in THIS manifest — resume picks them up on the next
   round/invocation.

5. **Route each entry's result:**
   - `status == "merged_removed"`: success. Mark the item's completion pending
     (Step 9 calls `quick-batch complete` for it — do NOT call it here; a
     `--validate` item still has verification ahead of it). **Clear the
     durable worktree-recovery fields now (#3677)** — the worktree no
     longer exists on disk, so its `dispatched_worktree`/`dispatched_branch`/
     `dispatched_base` must not keep pointing at a removed path:
     ```bash
     gsd_run quick-batch update --batch "$BATCH_ID" --updates '[{"quickId":"'"$quick_id"'","dispatchedWorktree":null,"dispatchedBranch":null,"dispatchedBase":null}]'
     ```
   - Any other status: route via
     ```bash
     gsd_run quick-batch merge-routing --kind merge_failed --detail "$reason" --raw
     ```
     (or `--kind scope_violation` when `$reason` names an undeclared
     deletion — `partitionDeclaredDeletions`'s own guard). The routing result
     always carries `preserveWorktree: true` — do NOT remove the worktree or
     branch for this item; leave it for diagnosis (row 28/34/35). Do NOT call
     `quick-batch complete` for it. Continue with the rest of the batch (row
     33 — unrelated items are unaffected).

Continue to Step 9 (`--validate` routes through the verification step first)
once every wave with a mergeable prefix has been processed this round.

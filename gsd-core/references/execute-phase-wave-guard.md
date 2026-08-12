0.5. **Inter-wave worktree base re-check (wave N+1 guard — #1369):**

   After Wave N merges and tracking commits advance orchestrator HEAD, Claude Code's
   `isolation="worktree"` still forks new worktrees from `origin/HEAD` (the "fresh" base),
   not the live HEAD. This means Wave N+1 worktrees would be created from the stale
   pre-Wave-N base, causing the `worktree_branch_check` guard inside each executor to halt
   immediately with a base-mismatch fatal.

   **Run this check at the start of every wave when `USE_WORKTREES != "false"` and
   `ISOLATION = "harness-worktree"`** (#2652 — the harness caches the fork base, so this is a
   property of the isolation model, not of the runtime name; Cursor declares it too),
   including Wave 1 (where it mirrors the initialize-step check):

   ```bash
   if [ "$ISOLATION" = "harness-worktree" ] && [ "${USE_WORKTREES:-true}" != "false" ]; then
     _WAVE_DEGRADE=$(gsd_run query worktree.base-check --pick shouldDegrade 2>/dev/null || true)
     if [ "$_WAVE_DEGRADE" = "true" ]; then
       _WAVE_DEGRADE_MSG=$(gsd_run query worktree.base-check --pick message 2>/dev/null || true)
       [ -n "$_WAVE_DEGRADE_MSG" ] && printf '%s\n' "$_WAVE_DEGRADE_MSG" >&2
       echo "⚠ [#1369] Worktree fork base diverged from orchestrator HEAD (wave merges advanced HEAD past origin/HEAD). Auto-degrading to sequential mode for this wave to avoid base-mismatch halts." >&2
       # Both must move together (#2652): dispatch keys on ISOLATION.
       USE_WORKTREES=false
       ISOLATION=none
     fi
   fi
   ```

   If `shouldDegrade` is `true`, override `USE_WORKTREES=false` for **this wave only** —
   all plans in this wave execute sequentially on the main working tree. Later waves re-run
   this check and may re-enable worktree isolation if `origin/HEAD` is updated (e.g. via
   `git fetch` or `worktree.baseRef:"head"` config).

   **To avoid this degrade across all waves:** set `worktree.baseRef:"head"` in
   `.claude/settings.local.json` (or run `gsd-tools worktree set-baseref`). This tells
   Claude Code to fork from the live HEAD instead of `origin/HEAD`, so each wave's new
   worktrees always start from the correct post-merge base. See #683 for the base-ref
   configuration detail.

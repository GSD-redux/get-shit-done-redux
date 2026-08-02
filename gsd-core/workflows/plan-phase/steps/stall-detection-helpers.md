# Bounded Stall-Detection Helpers (#2650)

Every planner/plan-checker spawn in `plan-phase.md` dispatches with
`run_in_background=true` and is immediately followed by a call to
`gsd_stall_watch`, defined here once. This mirrors the already-shipped
`executor.stall_*` pattern (`execute-phase.md`, bug #3212, commit
`e7942c21b`) but — unlike that prose-only surveillance, which cannot run
during a *blocking* `Agent()` call — `gsd_stall_watch` is a real, bounded
bash subprocess wait issued as its own tool call immediately after dispatch,
so it returns control to the orchestrator on its own schedule regardless of
whether the backgrounded agent's own completion notification ever arrives.
This block is independent of, and never gated behind, the `query
teams-status` / `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` guard used for the
researcher spawn — the stall path applies on every runtime, teams-active or
not (AC2).

```bash
PLANNER_STALL_INTERVAL_MINUTES=$(gsd_run query config-get planner.stall_detect_interval_minutes 2>/dev/null || echo "5")
PLANNER_STALL_THRESHOLD_MINUTES=$(gsd_run query config-get planner.stall_threshold_minutes 2>/dev/null || echo "10")

# gsd_stall_should_recover — pure decision function, no IO, no sleeping. Given how
# long the orchestrator has been waiting plus two liveness signals (a completion
# marker found in the agent's output file, and fresh on-disk artifact activity),
# decides whether to keep waiting, treat the wait as satisfied, or auto-surface the
# existing accept/retry/stop recovery menu (9a/11a). Never kills or retries anything
# itself — it only classifies.
gsd_stall_should_recover() {
  local elapsed_seconds="$1" threshold_minutes="$2" marker_found="$3" artifact_fresh="$4"
  local threshold_seconds=$(( threshold_minutes * 60 ))
  if [ "$marker_found" = "true" ]; then
    echo "marker_received"; return 0
  fi
  if [ "$artifact_fresh" = "true" ]; then
    echo "active"; return 0
  fi
  if [ "$elapsed_seconds" -ge "$threshold_seconds" ]; then
    echo "stalled"; return 0
  fi
  echo "waiting"; return 0
}

# gsd_stall_watch — bounded, real (non-LLM-side) polling loop. Blocks THIS ONE tool
# call for at most PLANNER_STALL_THRESHOLD_MINUTES minutes, checking every
# PLANNER_STALL_INTERVAL_MINUTES for a completion marker in $1 (the outputFile
# returned by the run_in_background=true Agent() call) or fresh mtime activity
# under $2 (an artifact glob). Remaining args are the completion markers to look
# for. Prints exactly one of: marker_received | active | stalled.
gsd_stall_watch() {
  local output_file="$1" artifact_glob="$2"; shift 2
  local markers=("$@")
  local dispatch_ts
  dispatch_ts=$(date +%s)
  while true; do
    sleep "$(( PLANNER_STALL_INTERVAL_MINUTES * 60 ))"
    local now elapsed marker_found artifact_fresh status
    now=$(date +%s)
    elapsed=$(( now - dispatch_ts ))
    marker_found="false"
    if [ -f "$output_file" ]; then
      for m in "${markers[@]}"; do
        if grep -qF "$m" "$output_file" 2>/dev/null; then marker_found="true"; break; fi
      done
    fi
    artifact_fresh="false"
    if [ -n "$(find $artifact_glob -newermt "@$(( now - PLANNER_STALL_INTERVAL_MINUTES * 60 ))" 2>/dev/null)" ]; then
      artifact_fresh="true"
    fi
    status=$(gsd_stall_should_recover "$elapsed" "$PLANNER_STALL_THRESHOLD_MINUTES" "$marker_found" "$artifact_fresh")
    if [ "$status" != "waiting" ] && [ "$status" != "active" ]; then
      echo "$status"
      return 0
    fi
  done
}
```

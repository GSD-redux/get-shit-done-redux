# Per-plan worktree decision (#2772)

Run this for **each plan in the current wave** before its `Agent()` dispatch. The output `USE_WORKTREES_FOR_PLAN` gates the dispatch branch (worktree mode vs sequential mode) for that plan only — other plans in the same wave can still take the worktree path.

`SUBMODULE_PATHS` is computed once in the `initialize` step (parsed from `.gitmodules`).

`PLAN_FILES` is the whitespace-separated list of paths the plan declared it will touch, extracted from the `phase-plan-index` JSON loaded in `discover_and_group_plans`:

```bash
# plan_json is the JSON object for this plan from PLAN_INDEX.plans[]
# files_modified is an array of strings (repo-relative paths or globs)
PLAN_FILES=$(jq -r '.files_modified // [] | join(" ")' <<<"$plan_json")
plan_id=$(jq -r '.id' <<<"$plan_json")
```

Then run the per-plan gate:

```bash
USE_WORKTREES_FOR_PLAN="$USE_WORKTREES"

if [ -n "$SUBMODULE_PATHS" ] && [ "$USE_WORKTREES_FOR_PLAN" != "false" ]; then
  if [ -z "$PLAN_FILES" ]; then
    # Fallback: planned paths are unknown/unparseable — fall back to the safe
    # behavior (disable worktree isolation for this plan) and log why.
    echo "[worktree] Plan ${plan_id}: files_modified missing/unparseable — disabling worktree isolation as a safety fallback (submodule project)"
    USE_WORKTREES_FOR_PLAN=false
  else
    # Compute intersection with glob-safe normalization. Both sides are
    # normalized (strip leading "./", strip trailing "/") and matched
    # bidirectionally so a globby planned path like "vendor/**/*.c" still
    # matches submodule "vendor/foo", and "./vendor/foo/bar.c" matches
    # submodule "vendor/foo".
    INTERSECT=""
    set -f  # disable globbing while iterating literal patterns
    for sm_raw in $SUBMODULE_PATHS; do
      # Normalize submodule path: strip ./ prefix and trailing /
      sm="${sm_raw#./}"
      sm="${sm%/}"
      [ -z "$sm" ] && continue
      for pf_raw in $PLAN_FILES; do
        # Normalize planned path the same way
        pf="${pf_raw#./}"
        pf="${pf%/}"
        [ -z "$pf" ] && continue
        matched=0
        # Direction 1: planned path is the submodule or lies inside it
        case "$pf" in
          "$sm"|"$sm"/*) matched=1 ;;
        esac
        # Direction 2: submodule lies inside the planned path (e.g. plan
        # declares "vendor" or a glob expanding to a directory containing
        # the submodule).
        if [ "$matched" -eq 0 ]; then
          case "$sm" in
            "$pf"|"$pf"/*) matched=1 ;;
          esac
        fi
        # Direction 3: planned path uses a glob — strip glob wildcards
        # and check whether the resulting prefix overlaps the submodule
        # path in either direction.
        if [ "$matched" -eq 0 ]; then
          case "$pf" in
            *'*'*|*'?'*|*'['*)
              # Take the literal prefix before the first glob metachar.
              prefix="${pf%%[*?[]*}"
              prefix="${prefix%/}"
              if [ -n "$prefix" ]; then
                case "$sm" in
                  "$prefix"|"$prefix"/*) matched=1 ;;
                esac
                if [ "$matched" -eq 0 ]; then
                  case "$prefix" in
                    "$sm"|"$sm"/*) matched=1 ;;
                  esac
                fi
              fi
              ;;
          esac
        fi
        if [ "$matched" -eq 1 ]; then
          INTERSECT="$INTERSECT $pf_raw"
        fi
      done
    done
    set +f
    if [ -n "$INTERSECT" ]; then
      echo "[worktree] Plan ${plan_id}: planned paths intersect submodule paths (${INTERSECT# }) — disabling worktree isolation for this plan"
      USE_WORKTREES_FOR_PLAN=false
    fi
  fi
fi
```

After running this for the plan, the dispatch branches in `execute_waves` step 3 MUST gate on `USE_WORKTREES_FOR_PLAN` for the current plan, not on the project-level `USE_WORKTREES`. Track which plans in this wave actually used worktrees (append `plan_id` to a `WAVE_WORKTREE_PLANS` accumulator when `USE_WORKTREES_FOR_PLAN != false`) — the post-wave cleanup step (5.5) uses this to decide whether worktree-merge cleanup is needed at all.

**Re-record the dispatch-isolation sentinel, scoped to THIS plan (#3045 BLOCKER 1):**

The phase-level sentinel (written by the "Resolve ISOLATION" step, before any per-plan decision exists) authorizes/denies at the PHASE level. This per-plan gate can override that decision (submodule intersection forcing `USE_WORKTREES_FOR_PLAN=false` on an otherwise harness-worktree phase) — without a fresh, plan-scoped re-record, the isolation guard hooks would still be reading the STALE phase-level `harness-worktree` sentinel when this plan's dispatch omits the isolation kwarg (correctly, since it isn't worktree-isolated), producing a false DENY; or, symmetrically, a plan-level submodule degrade elsewhere in the wave could leave a stale `none` sentinel that a LATER, genuinely harness-worktree plan's own dispatch could be misread against. Run this immediately before dispatching THIS plan (right after computing `USE_WORKTREES_FOR_PLAN` above), so the sentinel is always fresh at the moment of dispatch and always keyed to the plan it authorizes:

```bash
if [ "$USE_WORKTREES_FOR_PLAN" = "false" ]; then
  # Submodule intersection (or an inherited USE_WORKTREES=false) forces
  # sequential dispatch for this plan specifically — force the resolver's
  # single write path to record `none`, scoped to this plan, even though the
  # phase/registry would otherwise resolve harness-worktree.
  gsd_run query dispatch-isolation --raw --phase "${PHASE_NUMBER:-}" --plan "$plan_id" --force-isolation none >/dev/null 2>&1 || true
else
  # No plan-level override — re-resolve normally, still scoped to this plan,
  # so the sentinel's `plan` field always matches the plan about to dispatch.
  gsd_run query dispatch-isolation --raw --phase "${PHASE_NUMBER:-}" --plan "$plan_id" >/dev/null 2>&1 || true
fi
```

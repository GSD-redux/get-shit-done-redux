# Claude orchestration — Workflow execution backend (BETA)

> Injected at `execute:wave:pre` `into: executor` only when
> `claude_orchestration.enabled` is true. Default-off; `onError: skip`.

## When this contribution is active

The Claude orchestration capability is **default-off and BETA**. It activates only
when ALL of the following hold:

1. `claude_orchestration.enabled` is `true` in `.planning/config.json`, AND
2. the active runtime is **Claude Code** (the Workflow tool is Claude / Agent
   SDK-specific), AND
3. `claude_orchestration.execution_backend` resolves to `workflow` — either
   explicitly, or via `auto` — **and** the Agent SDK version is
   `>= claude_orchestration.min_agent_sdk_version` (default `0.3.149`). The SDK
   floor applies in both `auto` and `workflow` modes (fail-closed: a pre-release
   or older SDK never activates the preview backend).

Detection is fail-closed: any miss degrades to **inline, manual, one-agent-per-
message dispatch** — exactly today's behaviour. On a non-Claude runtime this
contribution is a no-op.

## Why `execute:wave:pre` (not `execute:wave:post`)

This is a **dispatch-backend selector** — it decides HOW a wave's executor agents
are spawned. That decision has to be made BEFORE the wave's `Agent()` calls in
`execute-phase.md` step 3, not after the wave has already finished (#2285). The
capability previously registered at `execute:wave:post`, which fires only after
worktree merge/post-merge tests/tracking updates — by then the wave was already
dispatched inline, so the contribution was structurally unable to change how
dispatch happened. This fragment is injected at the point that actually precedes
dispatch.

## What the orchestrator does when the Workflow backend is active

Before spawning executor agents for the current wave (execute-phase.md step 3),
resolve the dispatch backend through the single composed CLI seam:

```bash
gsd-tools claude-orchestration resolve-wave-dispatch \
  --waves "$WAVE_MANIFEST_PATH" --run-id "$PHASE_RUN_ID" \
  --runtime "$RUNTIME" \
  --phase-dir "$PHASE_DIR" --raw
```

`--agent-sdk-version` is no longer passed here (#2590). The router resolves the
installed Agent SDK version itself; see **Agent SDK version** below. The former
`${AGENT_SDK_VERSION:+--agent-sdk-version "$AGENT_SDK_VERSION"}` line was also
**shell-dependent**: zsh does not word-split unquoted parameter expansions, so it
collapsed to a SINGLE argv element there, `argValue()` never matched, and the run
failed into `agent_sdk_version_unknown` — indistinguishable from genuinely
unknown. Pass `--agent-sdk-version <ver>` explicitly only to pin a version.

This composes `detectWorkflowBackend` (the gate ladder above) with
`emitWorkflowScript` (the wave→plan mapping below) in ONE call — the pure
function backing it is `resolveWaveDispatch` in
`gsd-core/bin/lib/claude-orchestration.cjs`. Response shape:
`{ backend: 'inline'|'workflow', reason, script?, summary? }`.

### Manifest construction (`$WAVE_MANIFEST_PATH`, `$PHASE_RUN_ID`, `$PHASE_DIR`)

These are NOT pre-existing execute-phase.md variables — the orchestrator builds
them at this step, from data it already has in-context from `discover_and_group_plans`
(the `PLAN_INDEX` JSON) and step 2.5 (the per-plan `USE_WORKTREES_FOR_PLAN` decision):

1. **`$PHASE_DIR`** — reuse `{phase_dir}` from the `INIT` bundle (already loaded
   in the `initialize` step). No new value needed.

2. **`$PHASE_RUN_ID`** — a stable identifier for THIS phase-execution attempt, so
   `resumeFromRunId` can resume an interrupted run without re-dispatching plans
   the Workflow tool already completed. Construct it deterministically —
   `execute-{phase_number}-{phase_slug}` — from `INIT`'s `phase_number`/`phase_slug`
   (both are already validated identifiers used elsewhere in this workflow, so
   they satisfy `emitWorkflowScript`'s `isScriptableIdentifier` check). Do NOT
   mint a new random id per wave — the SAME `$PHASE_RUN_ID` is reused for every
   wave in the phase so the Workflow tool can correctly track cross-wave resume
   state.

3. **`$WAVE_MANIFEST_PATH`** — a fresh temp file for THIS wave's manifest (one
   wave = one `waves` array with a single entry, matching the wave-by-wave
   dispatch loop; do not batch multiple waves into one manifest — waves are
   dispatched in wave order, not all at once):

   ```bash
   WAVE_MANIFEST_PATH=$(mktemp "${TMPDIR:-/tmp}/gsd-wave-dispatch-XXXXXX") && mv "$WAVE_MANIFEST_PATH" "$WAVE_MANIFEST_PATH.json" && WAVE_MANIFEST_PATH="$WAVE_MANIFEST_PATH.json"
   ```

   Then **use the Write tool** (not a bash/jq pipeline — the orchestrator already
   has every field parsed in-context) to write the manifest JSON to
   `$WAVE_MANIFEST_PATH`:

   ```json
   {
     "waves": [
       {
         "id": "wave-{N}",
         "plans": [
           {
             "id": "{plan_id}",
             "brief": "{the SAME <objective>...<success_criteria> prompt block step 3 builds for this plan's inline Agent() call}",
             "files_modified": ["{from PLAN_INDEX.plans[].files_modified for this plan}"],
             "use_worktree": {true unless step 2.5 set USE_WORKTREES_FOR_PLAN=false for this plan}
           }
         ]
       }
     ]
   }
   ```

   - **`id`** — the plan id from `PLAN_INDEX`, e.g. `"01-01"`.
   - **`brief`** — MUST carry the same task content as step 3's inline `Agent()`
     prompt (the `<objective>`/`<execution_context>`/`<files_to_read>`/
     `<success_criteria>` block, with `{plan_number}`/`{phase_number}`/
     `{phase_name}` substituted) — a short summary here would NOT reproduce
     step 3's behavior and would violate the "identical artifacts" contract.
   - **`files_modified`** — copy verbatim from the plan's `PLAN_INDEX` entry.
   - **`use_worktree`** — `true` for every plan UNLESS step 2.5's per-plan
     worktree gate (`execute-phase/steps/per-plan-worktree-gate.md`) set
     `USE_WORKTREES_FOR_PLAN=false` for that plan (submodule-touching plan, or
     project-level `USE_WORKTREES=false`) — in which case pass `false` here so
     `emitWorkflowScript` omits `isolation: "worktree"` for that plan (#2772 /
     #2285 finding 1). **Never** hardcode `true` — that would force worktree
     isolation on a plan the inline path explicitly keeps out of worktrees.

4. **`$AGENT_SDK_VERSION`** — no longer built here; the router resolves it.

**Agent SDK version:** the orchestrator has no *bash-computable* way to
introspect the live Agent SDK version — but the router runs in Node, so it
resolves the version itself (#2590), in this order:

1. an explicit `--agent-sdk-version <ver>` (pin a version),
2. `GSD_AGENT_SDK_VERSION`,
3. the **installed** `@anthropic-ai/claude-agent-sdk` package version, read from
   its `package.json` on disk by walking `node_modules` up the tree. (Read
   directly rather than via `require.resolve`: the SDK's `exports` map does not
   expose `./package.json`, so `require.resolve` throws
   `ERR_PACKAGE_PATH_NOT_EXPORTED`.)

Previously nothing computed this at all, so gate 5 returned
`agent_sdk_version_unknown` on **every** automated run and the Workflow backend
could never activate — while `gsd-tools capability state` still reported the
capability `active: true`. Fail-closed is preserved: when no version can be
resolved, gate 5 still declines to `inline`. What changed is that a resolvable
version is now actually found, so a genuinely-too-old SDK reports
`agent_sdk_version_below_floor` — the truthful reason — instead of `unknown`.

**If `backend == "workflow"`:** run the emitted `script` via the Workflow tool
for THIS wave instead of the per-message `Agent()` loop in step 3. The script
composes the SAME `gsd-executor` agent type the inline path uses, with
worktree isolation applied PER PLAN from the manifest's `use_worktree` field
(see `emitWorkflowScript`):

- **waves → one or more sequential `parallel()` barriers** — each wave is a
  barrier group; when plans within a wave share `files_modified`, they are split
  into separate sequential stages within that wave's barrier.
- **plans → `agent(brief, { agentType: 'gsd-executor', isolation: 'worktree' })`**
  when `use_worktree` is not `false`, or `agent(brief, { agentType: 'gsd-executor' })`
  (no isolation) when it is — so the produced `SUMMARY.md` and commits are
  identical to inline dispatch, INCLUDING the inline path's submodule safety
  gate (#2772 / #2285 finding 1).
- **`files_modified` overlap → separate sequential stages** — the same overlap
  rule execute-phase already applies inline (step 1 of the wave loop).
- **`resumeFromRunId`** — **pass `summary.resumeRunId` as the Workflow tool's
  `resumeFromRunId` INPUT when you invoke the tool.** It is a tool parameter,
  not a script function; the script deliberately does not call it (#2590 — doing
  so threw "resumeFromRunId is not defined" and rejected the entire script).
  Omitting it from the tool invocation silently regresses phase-resume to a
  no-op: an interrupted phase re-runs completed plans.

The orchestrator still runs steps 4–5.8 (wait for completion, worktree cleanup,
post-merge gate, tracking update) exactly as it does for inline dispatch — the
Workflow backend only replaces HOW agents are spawned for this wave, not what
happens after they return.

**If `backend == "inline"`** (any gate miss, or `resolve-wave-dispatch` itself
unavailable/erroring): proceed to step 3's standard per-message `Agent()`
dispatch — the default, byte-identical-to-today path. `onError: skip` on this
contribution means a `resolve-wave-dispatch` command failure is treated exactly
like an `inline` result, never as a fatal wave error.

## Fallback contract

Detection is fail-closed end-to-end: capability disabled, non-Claude runtime,
`execution_backend:"inline"`, missing/incapable host descriptor, unknown or
below-floor Agent SDK version, or an `emitWorkflowScript` failure on a malformed
wave manifest — ANY of these degrades to `backend:"inline"` and execute-phase's
standard inline dispatch (step 3) runs unmodified. The Workflow backend never
partially activates; the executor MUST NOT assume parallelism, a shared budget,
or resume-from-run-id semantics when `backend == "inline"`.

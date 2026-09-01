# Executor session-survivability dispatch

Read and follow this fragment from `execute-phase.md` step 3 after resolving
`SESSION_OUTLIVES_TURN`. It controls executor invocation only; it does not
change verifier dispatch, isolation selection, or worktree ownership.

## harness Agent dispatch

When `SESSION_OUTLIVES_TURN` is `true` (default), retain the existing
asynchronous executor contract:

```text
Agent(
  subagent_type="{EXECUTOR_TYPE}",
  description="Execute plan {plan_number} of phase {phase_number}",
  model="{executor_model}",  # omit when executor_model == "inherit"
  {harnessFlag},
  run_in_background=true,
  prompt="
    <objective>
    Execute plan {plan_number} of phase {phase_number}-{phase_name}.
    Commit each task atomically. Create SUMMARY.md.
    </objective>
    <required_reading>
    Read the plan, PROJECT.md, STATE.md, config.json (if present), and the
    project instructions before editing. Follow the gsd-executor role contract,
    including its per-commit HEAD/cwd/path guards and gitignored-artifact skip
    semantics: never force-stage a gitignored planning artifact.
    </required_reading>
  "
)
```

When `SESSION_OUTLIVES_TURN` is `false`, make the executor foreground and wait
for its completion before dispatching the next plan's executor:

```text
executor_result = Agent(
  subagent_type="{EXECUTOR_TYPE}",
  description="Execute plan {plan_number} of phase {phase_number}",
  model="{executor_model}",  # omit when executor_model == "inherit"
  {harnessFlag},
  run_in_background=false,
  prompt="
    <objective>
    Execute plan {plan_number} of phase {phase_number}-{phase_name}.
    Commit each task atomically. Create SUMMARY.md.
    </objective>
    <required_reading>
    Read the plan, PROJECT.md, STATE.md, config.json (if present), and the
    project instructions before editing. Follow the gsd-executor role contract,
    including its per-commit HEAD/cwd/path guards and gitignored-artifact skip
    semantics: never force-stage a gitignored planning artifact.
    </required_reading>
  "
)
```

The call blocks and returns the executor's result synchronously. Do not dispatch
the next plan's executor until this call has returned.

## orchestrator-worktree process dispatch

The isolation fragment receives `SESSION_OUTLIVES_TURN` as an already-resolved
value. Its true path background-spawns the resolved command; its false path
runs the same command synchronously and waits before the next executor.

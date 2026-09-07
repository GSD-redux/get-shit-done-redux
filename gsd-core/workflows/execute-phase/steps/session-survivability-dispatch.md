# Executor session-survivability dispatch

Read and follow this fragment from `execute-phase.md` steps 3 and 10 after
resolving `SESSION_OUTLIVES_TURN`. It controls executor and verifier invocation;
isolation selection and worktree ownership remain unchanged.

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

## verifier Agent dispatch

At `verify_phase_goal`, use exactly one branch based on the already-resolved
`SESSION_OUTLIVES_TURN` value. The foreground branch must return before reading
verification status.

When `SESSION_OUTLIVES_TURN` is `true` (default), retain asynchronous verifier
dispatch:

```text
Agent(
  description="Verify phase {phase_number} goal achievement",
  prompt="Verify phase {phase_number} goal achievement.
Phase directory: {phase_dir}
Phase goal: {goal from ROADMAP.md}
Phase requirement IDs: {phase_req_ids}
Check must_haves against actual codebase.
Cross-reference requirement IDs from PLAN frontmatter against REQUIREMENTS.md — every ID MUST be accounted for.
Create VERIFICATION.md.

<required_reading>
Read these files before verification:
- {phase_dir}/*-PLAN.md (All plans — understand intent, check must_haves)
- {phase_dir}/*-SUMMARY.md (All summaries — cross-reference claimed vs actual)
- {requirements_path} (Requirement traceability)
${CONTEXT_WINDOW >= 500000 ? `- {phase_dir}/*-CONTEXT.md (User decisions — verify they were honored)
- {phase_dir}/*-RESEARCH.md (Known pitfalls — check for traps)
- Prior VERIFICATION.md files from earlier phases (regression check)
` : ''}
</required_reading>

${VERIFIER_SKILLS}",
  subagent_type="gsd-verifier",
  model="{verifier_model}",
  run_in_background=true
)
```

When `SESSION_OUTLIVES_TURN` is `false`, dispatch the verifier in the
foreground and wait for its result before continuing:

```text
verifier_result = Agent(
  description="Verify phase {phase_number} goal achievement",
  prompt="Verify phase {phase_number} goal achievement.
Phase directory: {phase_dir}
Phase goal: {goal from ROADMAP.md}
Phase requirement IDs: {phase_req_ids}
Check must_haves against actual codebase.
Cross-reference requirement IDs from PLAN frontmatter against REQUIREMENTS.md — every ID MUST be accounted for.
Create VERIFICATION.md.

<required_reading>
Read these files before verification:
- {phase_dir}/*-PLAN.md (All plans — understand intent, check must_haves)
- {phase_dir}/*-SUMMARY.md (All summaries — cross-reference claimed vs actual)
- {requirements_path} (Requirement traceability)
${CONTEXT_WINDOW >= 500000 ? `- {phase_dir}/*-CONTEXT.md (User decisions — verify they were honored)
- {phase_dir}/*-RESEARCH.md (Known pitfalls — check for traps)
- Prior VERIFICATION.md files from earlier phases (regression check)
` : ''}
</required_reading>

${VERIFIER_SKILLS}",
  subagent_type="gsd-verifier",
  model="{verifier_model}",
  run_in_background=false
)
```

<!-- end verifier Agent dispatch -->

## Converge Dispatch (Background)

If `PLAN_STRATEGY=converge`, print: `◆ Spawning background plan-convergence loop for phase ${PHASE_NUM}... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)`

```
Agent(
  description="Plan convergence phase ${PHASE_NUM}: ${PHASE_NAME}",
  run_in_background=true,
  prompt="Run plan convergence for phase ${PHASE_NUM}: Skill(skill=\"gsd-plan-review-convergence\", args=\"${PHASE_NUM} ${CONVERGENCE_ARGS}\")"
)
```

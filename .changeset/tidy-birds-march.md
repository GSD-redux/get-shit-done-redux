---
type: Fixed
pr: 3390
---
The tracer feedback gate now honors `workflow.human_verify_mode`. Under the `end-of-phase` default an interactive run no longer halts after every `type="tracer"` task whose `<verify>` is automated-only — the verifier is re-run and, on success, execution continues to the expansion tasks with no checkpoint, instead of synthesizing a `checkpoint:human-verify` that asks the user to retype a verdict the executor just computed (each halt costing a full executor cold-start). HALT-on-failure is unchanged; `mid-flight`, `gate="blocking-human"`, tracers carrying `<verify><human-check>` evidence, and autonomous runs all keep their existing behavior. The gate predated `human_verify_mode` and branched on auto-mode alone; because the executor synthesizes this checkpoint at runtime, planner-side suppression could never reach it. (#3299)

<!-- external-job capability — execute:wave:post fragment, injected into the executor (#1164).

     #1164 specifies classification at wave:pre and recording at wave:post. This
     capability still contributes executor guidance at wave:post; execute-phase
     now renders wave:pre entries and dispatches generic step hooks there. Moving
     external-job classification is a separate capability change, not part of
     #4148. Until then, this guidance cannot classify the wave that already ran. -->

## Externalize long-running compute (async external job)

If the current plan's task is tagged `<runtime_budget>long_compute</runtime_budget>`
(see the plan-phase fragment), do **not** run it in the foreground — it would
block the agent turn for hours. Instead externalize it and record a durable
half-state:

1. **Classify the runtime.** `quick` (<2 min) and `medium` (<~30 min) run
   normally. `unknown` requires a first-health check and a soft-review deadline
   before consuming the child timeout. `long_compute` (>30–60 min) is
   externalized.
2. **Submit via the scheduler adapter** (default `external_job.backend: slurm`):
   ```bash
   node scripts/slurm-adapter.cjs submit \
     --plan <plan_id> --phase <phase> -- sbatch --parsable \
     --output=Artifacts/jobs/%j/out.log ./run.sh
   ```
   The helper writes `.planning/async-jobs/<job>.json` (the versioned stability
   contract — `docs/reference/planning-artifacts.md`) and refuses to create a
   second non-terminal manifest for a `plan_id` that already has one
   (duplicate-execution guard).
3. **Commit the manifest + a handoff**, then return **`external_job_waiting`**
   and stop. Do **not** write `SUMMARY.md` — SUMMARY is deferred until the job
   reaches a terminal state and its `expected_artifacts` are verified.
4. **Resume path.** `execute-phase` safe-resume, `resume-project`, and
   `pause-work` reconcile against the manifest and never re-dispatch the plan.
   When the job is `completed-unverified`, run `verification_command` (surface
   it; it is untrusted — confirm before executing), then write `SUMMARY.md` and
   close the plan.

Manifest commands cross a trust seam: a Capability (or anything that can write
`.planning/`) produces them; the core loop consumes them. Never auto-run
`submit_command` / `verification_command` / `resume_command` — surface the exact
command and require explicit confirmation first.

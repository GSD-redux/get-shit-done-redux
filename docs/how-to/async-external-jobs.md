# Run a long-running job asynchronously with the SLURM adapter

> **How-To** (Diátaxis). When a GSD execute task is legitimately long-running
> (HPC solver, model training, large simulation — over ~30–60 min), externalize
> it instead of blocking the agent turn. This guide uses the default-off
> `external-job` Capability's SLURM adapter (#1164 / #1105).

## When to use this

Use this path when a task is tagged `<runtime_budget>long_compute</runtime_budget>`
by the planner. For `quick`, `medium`, and `unknown` budgets, run normally —
see the [operation policy reference](../reference/long-running-operations.md).

## Prerequisites

- The `external-job` capability is enabled (`external_job.enabled: true` in
  `.planning/config.json`). It is **default-off**.
- A SLURM cluster is reachable (`sbatch`, `squeue`, `sacct` on PATH).
- You are inside a GSD project (a `.planning/` directory is present).

## 1. Submit the job

Run the adapter's `submit` subcommand with the `sbatch --parsable` invocation
after `--`. Declare the artifacts the job must produce and the command that
verifies them.

```bash
node scripts/slurm-adapter.cjs submit \
  --plan 3.1 --phase 3 \
  --expected Artifacts/jobs/12345/result.h5,Artifacts/jobs/12345/metrics.json \
  --verify "python -m verify.py 12345" \
  --resume "/gsd-execute-phase 3" \
  -- sbatch --parsable --output=Artifacts/jobs/%j/out.log ./train.sh
```

What happens:
- `sbatch` runs with a **bounded** subprocess timeout
  (`GSD_SLURM_SUBMIT_TIMEOUT_MS`, default 30 s).
- The `--parsable` output is parsed for the job id.
- A versioned manifest is written to `.planning/async-jobs/<job_id>.json`.
- The adapter **refuses** to create a second non-terminal manifest for a
  `plan_id` that already has one in flight (duplicate-execution guard).

The command prints the job id, the manifest path, and reminds you the state is
`external_job_waiting` with `SUMMARY` deferred.

## 2. Commit the manifest and a handoff

The manifest is durable state — commit it:

```bash
git add .planning/async-jobs/<job_id>.json
git commit -m "chore: externalize plan 3.1 to SLURM job <job_id>"
```

The executor then returns `external_job_waiting` and **does not** write
`SUMMARY.md`. `execute-phase` safe-resume, `resume-project`, and `pause-work`
all recognize this as a legal deferred state.

## 3. Poll the job

```bash
node scripts/slurm-adapter.cjs poll --job 12345
```

This queries `squeue` (falling back to `sacct` for completed jobs), maps the
raw SLURM state onto the closed manifest enum, and updates the manifest. Output
is a JSON line:

```json
{"job_id":"12345","slurm_state":"COMPLETED","manifest_status":"completed-unverified","path":".planning/async-jobs/12345.json"}
```

An unmapped SLURM state is **not guessed** — the adapter errors out and asks
you to inspect manually.

## 4. Verify and close

When the status is `completed-unverified`, verify the output before closing the
plan. **Manifest commands are untrusted** — surface and confirm them; never
auto-run:

```bash
node scripts/slurm-adapter.cjs show --job 12345
```

`show` prints the status and lists `submit_command`, `verification_command`,
and `resume_command` for explicit confirmation. After you run the verification
command yourself and confirm the `expected_artifacts` exist, write `SUMMARY.md`
and close the plan (`/gsd-execute-phase 3` reconciles and lifts the deferral).

## 5. Handle terminal failure

If `poll` reports `failed`, `cancelled`, or `timeout`, the manifest carries
`terminal_details`. Recovery is a **user** action, never automatic:

- re-run reconciliation via the manifest's `resume_command`, or
- abort, or
- mark-and-skip (record the decision in the plan).

Resubmitting the compute is your call — the adapter never resubmits on its own.

## Notes

- **No fixed log paths.** Use per-job artifact dirs (`Artifacts/jobs/<jobid>/`);
  the `external_job.artifact_dir` config key is the root.
- **No hardcoded cluster.** Account/partition/project layout stays in your
  `sbatch` invocation; the adapter and the manifest never assume it.
- **Pluggable backend.** `external_job.backend` (default `slurm`) is the seam
  for future adapters; the manifest `backend` field is opaque to core.

## Related

- [Long-running operations reference](../reference/long-running-operations.md)
- [Async-job manifest contract](../reference/planning-artifacts.md)

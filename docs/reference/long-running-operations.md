# Long-running operations and async external jobs

> **Reference** (Diátaxis). The operation-classification policy and the async
> external-job contract that GSD executors use when a task legitimately exceeds
> a child-agent timeout. The producer is the default-off `external-job`
> Capability (#1164, part of #1105); the core loop consumes the manifest
> (#1165 — `external_job_waiting`).

## 1. The problem

Heavy GSD phases (HPC solvers, model training, large simulations) can
legitimately exceed short child-agent timeouts. Raising the timeout alone is
not sufficient: it prevents legitimate subagents from being killed, but it
also lets truly hung commands consume the whole agent budget. GSD must
distinguish legitimate heavy work from suspicious hangs, keep safety nets
finite, and avoid blocking an agent turn on hours-long compute.

## 2. Operation classification policy

Every executable task carries a runtime budget. Planners emit it via a
`<runtime_budget>` element (taught by the `external-job` Capability's
`plan:post` fragment); executors branch on it at `execute:wave:post`.

> **Contribution point.** `#1164` specifies classification at
> `execute:wave:pre` and recording at `execute:wave:post`. This Capability still
> contributes executor guidance at `execute:wave:post`; `execute-phase.md` now
> renders `wave:pre` entries and dispatches generic step hooks there. Moving
> external-job classification is a separate capability change, not part of
> `#4148`. Until then, this guidance cannot classify the wave that already ran.

| Budget | Meaning | Execute behavior |
|---|---|---|
| `quick` | Under ~2 min | Run normally in the foreground. |
| `medium` | ~2–30 min | Foreground, but with explicit progress expectations. |
| `unknown` | Runtime not characterized | Run a **first-health check** and set a **soft-review deadline** before trusting the child timeout. Define a progress signal, an abort condition, and expected output. A truly hung command must surface before the child timeout is exhausted. |
| `long_compute` | Over ~30–60 min | **Externalize** — submit an async external job, record durable state, and return `external_job_waiting`. Never block the agent turn. |

The classification is advisory metadata; the executor owns the decision at
dispatch time. `unknown` is the safety-critical class: it is what catches a
hung solver before it burns the budget, without making timeouts infinite.

## 3. The async external-job half-state

When an executor externalizes a `long_compute` task it enters a **legal
deferred state**, not an illegal partial-plan state:

```
input/code committed
external job submitted
.planning/async-jobs/<job>.json committed
handoff committed
SUMMARY.md deferred until verification
```

`SUMMARY.md` is deferred until the job reaches a terminal state **and** its
`expected_artifacts` are verified. Until then, the plan is
`external_job_waiting`, and every resume/pause/dispatch path reconciles
against the manifest — it never re-dispatches the plan (re-dispatching would
duplicate the external job).

## 4. The manifest — a versioned stability contract

The manifest schema, status enum, trust boundary, matching rules, and the
glob-safe matching probe are the **stability contract** documented in
[`planning-artifacts.md`](./planning-artifacts.md#planningasync-jobsjobjson).
The core loop depends only on the named fields and ignores any others; the
`version` field is the evolution escape hatch. Producers MUST write the named
fields and MAY add their own.

Status enum (closed, scheduler-agnostic — producers map backend states onto
these):

| Status | Class | Resume action |
|---|---|---|
| `submitted`, `running` | non-terminal | Re-check; never re-dispatch. |
| `completed-unverified` | finished, unverified | Verify `expected_artifacts` / run `verification_command`; on success write `SUMMARY.md` and close. |
| `failed`, `cancelled`, `timeout` | terminal failure | Surface `terminal_details`; offer recovery (re-run reconciliation, abort, or mark-and-skip). Resubmitting compute is a user action, never automatic. |

## 5. Trust boundary

The manifest crosses a trust seam: a Capability (or anything that can write
`.planning/`) produces it; the core loop consumes it. `submit_command`,
`verification_command`, and `resume_command` are therefore **untrusted**. The
core loop — and the `slurm-adapter` `show` subcommand — surface these commands
for explicit operator confirmation; they are **never** auto-executed. Validate
before trusting a manifest: recognized `version`, `plan_id` matches the plan
under reconciliation, and `status` is one of the closed enum values. On a
malformed manifest or multiple manifests for one `plan_id`, **fail closed**.

## 6. Scheduler pluggability

SLURM is the first backend. The design does not hardcode a cluster, account,
partition, or project layout — per-job artifact directories
(`external_job.artifact_dir`, default `Artifacts/jobs/<jobid>/`) avoid fixed
log paths. The `backend` field on the manifest (opaque to core) and the
`external_job.backend` config key are the pluggability seams for future
backends (LSF, PBS, Kubernetes batch). The pure producer logic — SLURM
state→manifest-status mapping, manifest build/validate, `sbatch`/`squeue`/
`sacct` parsers, and the fail-closed writer — is backend-aware but lives
behind a single module; a new backend adds a sibling state map and parser
without touching core.

## 7. Configuration

The `external-job` Capability declares its config keys in
[`capability.json`](../../capabilities/external-job/capability.json) and the
`slurm-adapter` resolves them through the canonical capability-config seam
(`resolveConfigKey` in `capability-activation.cjs`). **Precedence: env override
> nested config value > registry default.**

| Key | Default | Env override | Read by |
|---|---|---|---|
| `external_job.enabled` | `false` | — | Capability gate (`when` on both contributions). Master toggle; default-off. |
| `external_job.backend` | `slurm` | — | Pluggability seam (LSF/PBS/K8s future). Core never interprets it. |
| `external_job.artifact_dir` | `Artifacts/jobs` | `GSD_EXTERNAL_JOB_ARTIFACT_DIR` | Adapter surfaces the resolved root in `submit` output. |
| `external_job.submit_timeout_ms` | `30000` | `GSD_SLURM_SUBMIT_TIMEOUT_MS` | Adapter bounds the `sbatch` subprocess. |
| `external_job.poll_timeout_ms` | `15000` | `GSD_SLURM_POLL_TIMEOUT_MS` | Adapter bounds the `squeue`/`sacct` subprocess. |

Config keys live nested under `external_job` in `.planning/config.json`, e.g.:

```json
{ "external_job": { "enabled": true, "submit_timeout_ms": 45000 } }
```

The timeouts are load-bearing for the bounded-subprocess policy: the adapter
never unbounds a scheduler subprocess, and a non-numeric config value falls back
to the registry default rather than producing `NaN` (no guessing).

## 8. Related

- **How-To:** [`../how-to/async-external-jobs.md`](../how-to/async-external-jobs.md) — using the SLURM adapter.
- **Contract:** [`planning-artifacts.md`](./planning-artifacts.md) — the manifest stability contract.
- **Capability manifest:** [`../../capabilities/external-job/capability.json`](../../capabilities/external-job/capability.json).
- **Pure module:** `gsd-core/src/external-job.cts` → `gsd-core/bin/lib/external-job.cjs`.
- **Operator CLI:** `scripts/slurm-adapter.cjs`.

# How to read CI timeout budget signals

Every matrixed CI job (`test`, `test-full` in `.github/workflows/test.yml`; `mutate` in
`mutation.yml`; `smoke` in `install-smoke.yml`) now reports how close it ran to its
`timeout-minutes` cap. This page is for a maintainer trying to answer: *is a lane drifting
toward its cap, and where do I look?*

## 1. A single run crossed 90% of its budget

Open the job's page in the Actions run — two places show it, both populated by the same
computation (`scripts/lib/ci-job-timing.cjs`):

- **The Checks tab annotation.** A `::warning::` line renders as an expandable warning banner
  on the PR's Checks summary, naming the job, its elapsed time, its cap, and the percentage —
  visible without opening the job's logs.
- **The job's step summary.** The same information, as a Markdown line, appended to the job's
  own summary page (`$GITHUB_STEP_SUMMARY`) by that job's own "Check job budget (near-cap
  advisory)" step — always the job's last step.

Neither signal fails the job. A near-cap warning on an otherwise-green run means exactly what
it says: this run finished, but with less margin than the headroom-factor gate assumes it has.

**If the warning never appears even on a job that was actually cancelled at its cap**, that is
expected — a killed job never reaches its last step, so the in-job check never runs. See §2.

## 2. Checking the accumulated trend

`.github/workflows/ci-timeout-report.yml` runs daily (and on-demand via `workflow_dispatch`). It
polls GitHub's Actions REST API directly — independent of whether any individual job's own
near-cap step ran — so it also catches jobs that were actually cancelled by a timeout breach
(GitHub's Jobs API still reports `started_at`/`completed_at` for a cancelled job).

Each run's new rows land in `tests/ci-timeout-budget-history.jsonl`, one JSON object per line:

```json
{"runId":123456,"jobName":"test (ubuntu-latest, 24, shard 1/3)","workflowFile":"test.yml","sha":"...","completedAt":"...","elapsedMs":432000,"timeoutMinutes":15,"pct":0.8,"runEvent":"push"}
```

`runEvent` matters for `install-smoke.yml`'s `smoke` job specifically — its `pull_request` runs
use a smaller matrix (no `macos-latest` `full_only` row) than its `push` runs, so a `pct` figure
only means the same thing across rows sharing the same `runEvent`.

Because `next` is a protected branch, the report never pushes directly to it — each scheduled
run opens (or the prior run's already merged, in which case a fresh one opens) a small,
data-only PR carrying just that run's new rows, titled `chore: CI timeout budget report — run
<id>`. Merge these like any other PR; there is nothing to review beyond "did the numbers land."

## 3. A lane is repeatedly near-cap — what to do

Neither mechanism here decides what to do about a lane that's genuinely trending toward its
cap. That is a maintainer call among three options, each with real tradeoffs:

- **Raise the `timeout-minutes` cap** for that job.
- **Rebalance the shard split** so no single shard carries a disproportionate share of the
  suite (see `scripts/run-tests.cjs`'s `selectShard`, which packs shards by measured cost from
  `tests/test-timings.json`).
- **Trim what runs on the long-pole shard** — for the `test` job, shard 1 also carries the
  unsharded aux suites (integration/security/install/slow); moving one elsewhere changes what
  shard 1 costs.

`tests/ci-test-job-timeout-budget.test.cjs` will keep failing to accept a lowered
`timeout-minutes` beneath 1.5x whatever `LANE_COSTS`/`COVERED[*].timeoutMinutes` records as that
job's last measured cost — raising the cap back down is not something either mechanism will
silently allow.

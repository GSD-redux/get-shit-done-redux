# How to enable parallel reviewer lanes

Cut the wall-clock cost of a multi-reviewer `/gsd-review` pass from the sum of its lanes toward
its slowest lane — without losing the rate-limit protection the sequential default exists to
provide.

> **Default-off, and deliberately so.** Reviewer lanes are dispatched one at a time because
> concurrent invocation can trip provider rate limits, and a lane lost to a rate limit is a
> cross-AI review that quietly went blind in one eye. Turning this on is you asserting that your
> providers can take the concurrency. Nothing detects that for you.

**What you need:**

- Two or more reviewer lanes that actually run on this host. With one lane there is nothing to
  overlap and the setting changes nothing.
- Provider capacity for concurrent requests — separate accounts, generous quota, or local model
  servers (`ollama`, `lm-studio`, `llama-cpp`) that have no external limit at all.

---

## Step 1 — Check what your review pass actually runs

Parallelism only helps if several lanes are selected. Confirm the set first:

```bash
gsd config-get review.default_reviewers
```

If that returns `Key not found`, no-flag runs use every detected reviewer and `--all` is
redundant. If it names a single reviewer, stop here — enabling the key would change nothing.

---

## Step 2 — Turn the key on

```bash
gsd config-set review.parallel_lanes true
```

Verify it took:

```bash
gsd config-get review.parallel_lanes --raw
# → true
```

**The guard is strict equality.** Only the exact value `true` opts in. `"1"`, `"yes"`, `"on"` and
`"TRUE"` are all read as *not enabled* and leave dispatch sequential. This is intentional: a
mistyped config gets the conservative behavior rather than firing concurrent requests at a
rate-limited provider. If `config-get` shows anything other than `true`, the setting is off.

---

## Step 3 — Run a review and read the result

```bash
/gsd-review --phase 3 --all
```

or, for the convergence loop:

```bash
/gsd-plan-review-convergence 3 --all
```

Open `{phase_dir}/{padded_phase}-REVIEWS.md` and check the `reviewers:` frontmatter list. Every
lane you selected must appear there. That list is the contract: lanes are joined before the file
is rendered, so a missing reviewer means that lane did not produce a review — never that
aggregation ran early.

Section order in `REVIEWS.md`, and line order in the run's `gsd-review-lane-results.jsonl`, are
unchanged from sequential dispatch. They follow reviewer-selection order, not completion order,
so a diff of two runs shows no reordering churn.

---

## Telling the outcomes apart

The single most useful habit: **an empty or stub review is a dropped lane, not a clean review.**
That is true sequentially too, but concurrency gives you more ways to drop one at once.

| What you see | What it means | What to do |
|---|---|---|
| Every selected lane in `reviewers:`, all sections populated | Working as intended | Nothing |
| A lane's section carries the "failed or returned empty output" header | The lane ran and produced nothing usable. Read the captured stderr in the stub | If it names a rate limit or quota, your provider cannot take this concurrency — see below |
| A lane reports `probe_timeout` or `host_unreachable` | The lane could not be reached at all — a local server that is down, not a concurrency effect | Start the server; unrelated to this setting |
| A lane reports `budget_too_small` | Its prompt budget cannot fit the minimum review set | Raise `review.max_prompt_tokens_per_reviewer.<slug>`; unrelated to this setting |
| A lane reports `egress_host_changed` | The lane was consented to one destination and the config now names another. It is blocked, not redirected | Re-consent deliberately; unrelated to this setting |
| A lane is missing from `reviewers:` entirely | It was never selected | Check your flags and `review.default_reviewers` |
| Several lanes stub out at once, with provider errors | The concurrency is more than your account can take | Turn the key back off, or narrow `review.default_reviewers` |

**Rate-limited lanes fail loudly.** A lane that gets throttled goes down the same path as any
other failing lane — a diagnostic stub carrying its stderr, kept distinguishable from a real
review by its header. It is not silently dropped and it does not abort its sibling lanes.

---

## Turning it back off

```bash
gsd config-set review.parallel_lanes false
```

The next pass dispatches sequentially again. Nothing else changes: no artifact written under the
parallel setting needs migrating, because the output layout is identical in both modes.

---

## What this does not speed up

**Convergence cycles stay sequential.** `/gsd-plan-review-convergence` runs
`plan-phase → review → replan → re-review`, and each cycle genuinely depends on the previous
one's output. Enabling this key makes each *review pass* inside a cycle faster; it does not
reduce the number of cycles, and it does not overlap planning with reviewing. A three-cycle
convergence run is still three sequential rounds.

**There is no concurrency bound.** Every selected lane dispatches at once. Eleven selected lanes
means eleven concurrent requests. If that is more than you want, the control is the size of your
selected set — `review.default_reviewers` or explicit flags — not a throttle on this setting.

**Reviewer instances sharing an adapter are not grouped.** Two
[`review.reviewer_instances`](../CONFIGURATION.md#reviewer-instances-for-gsd-review-1517) entries
backed by the same CLI dispatch concurrently against that one provider. If you run several
same-provider instances, you are the most likely configuration to hit a limit, and this setting
gives you no way to serialize just those.

---

**See also:** [Configuration reference](../CONFIGURATION.md#parallel-reviewer-lanes-for-gsd-review-3034)
· [Reviewer instances](../CONFIGURATION.md#reviewer-instances-for-gsd-review-1517)
· [`/gsd-review` command reference](../COMMANDS.md)

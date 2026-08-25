---
id: 165
title: Opt-In Parallel Reviewer Lanes
group: v1.7.0 Features
---

**Command:** `/gsd-review`, `/gsd-plan-review-convergence`

**Config key:** `review.parallel_lanes` (default `false`)

**Purpose:** Reviewer lanes within one review pass have no data dependency on each other — they all inspect the same immutable plan snapshot — but were dispatched strictly one at a time, so a pass with Codex, Gemini and Claude cost roughly the sum of three long reviewer calls. The serialization was a deliberate, unconditional protection against provider rate limits, which made it a global policy imposed on users whose providers could comfortably take concurrent requests, or who run local model servers with no limits at all (#3034).

**Behavior:** With the key enabled, the `invoke_reviewers` step dispatches each selected lane as a background job and joins all of them before `REVIEWS.md` and consensus are rendered. Wall-clock cost falls toward the slowest lane rather than the sum. Default remains `false`, preserving the existing sequential dispatch and its rate-limit protection.

**The guard is strict equality, and it fails safe.** Only the exact value `true` opts in — `"1"`, `"yes"` and `"TRUE"` all stay sequential, so a mistyped config gets the conservative behavior rather than concurrent requests at a rate-limited provider. A failure to read the config falls back to sequential too. This polarity is deliberately the opposite of the `commit_docs` guard, which fails open: there, failing open preserves user intent; here it would fire the very requests the default exists to prevent.

**Result ordering is unchanged in both modes.** Per-lane results are written to slug-scoped files and concatenated in reviewer-selection order after the join, so `gsd-review-lane-results.jsonl` reads identically whether lanes ran sequentially or concurrently. Completion order never reaches the artifact. This also means concurrent lanes never share an append handle — a lane result larger than the pipe-atomicity bound cannot interleave and corrupt the `models:` / `model_sources:` frontmatter that `write_reviews` renders from that file.

**Per-lane semantics are untouched.** Timeouts, prompt budgets, the diagnostic stub for an empty or failed lane, explicit-lane failure ([ADR-2782](adr/2782-reviewer-lane-capability-surface.md) D4), trust/egress checks and result-file layout all behave exactly as they do sequentially. A failing lane does not abort its siblings.

**Known limits:** convergence cycles stay sequential by design (`review → replan → re-review` has a genuine data dependency), so this speeds up each pass rather than reducing the number of passes; there is no concurrency bound, so every selected lane dispatches at once; and reviewer instances sharing one adapter dispatch concurrently against that single provider, which is the most likely way to hit a limit.

**Reference:** [Configuration](CONFIGURATION.md#parallel-reviewer-lanes-for-gsd-review-3034) · [Enable parallel reviewer lanes](how-to/enable-parallel-reviewer-lanes.md) · [Commands](COMMANDS.md)

---
id: 3885
title: No Silent Swallow, No Verdict From Dropped Data
group: v1.7.0 Features
---

**Purpose:** ADR-3473 §8.5 states the rule directly: a failure or a gap in the
input must not be absorbed into an output that reads as authoritative. A
routine that drops data it could not read or could not resolve, and then
reports a clean result anyway, turns a diagnosable gap into a confidently
wrong answer. This closes four instances of that collapse found across
`gsd-tools`.

**`intel query` no longer crashes past ~12000 levels of nesting (#3427).**
`searchJsonEntries` / `matchesInValue` recursed with no depth bound at all —
an intel JSON file nested deeply enough overflowed the call stack with an
uncaught `RangeError` instead of a diagnosis. The original SDK-era bound
(`MAX_JSON_SEARCH_DEPTH = 48`, lost in the ADR-0174 consolidation) is
restored, paired with a `truncated` result field: a match at or above the
ceiling is not returned, and the result says so rather than reporting a bare
"not found" that is indistinguishable from a genuine miss. A match at depth
48 (inclusive) or shallower is unaffected; the bound is on nesting depth, not
breadth or total node count, so a shallow object with many siblings still
works unchanged.

**`phase-plan-index` no longer blames the author for an edge the tool itself
dropped (#3427).** A `depends_on:` token that resolves to no plan in the
phase (typo, or a stale cross-phase reference) silently dropped that edge,
making the dependent plan a DAG root — its own docstring recorded the intent
as "ignore this edge, never a throw." The tool then compared the resulting
degraded wave against the plan's declared `wave:` and reported the *author's
correct* declaration as a mismatch. The unresolved token is now named in its
own `warnings[]` entry (plan and token together), and the wave-mismatch
warning is suppressed for that plan only — a plan with no dropped edges and a
genuinely wrong `wave:` still warns as before. The token is escaped
(quoted, control characters and embedded newlines backslash-escaped) before
it is embedded in the warning text, so a `depends_on` value crafted to
contain a newline or a quote cannot forge a second, fabricated warning entry.

**A code-review run where every lane failed no longer writes `REVIEWS.md`
from nothing (#3352).** `review.md`'s aggregation step wrote `REVIEWS.md`
regardless of whether any lane actually produced results — a run where every
lane failed still emitted a completed-looking review artifact, and the
per-lane outputs and `.err` files that would have explained the failure were
then destroyed by the run's own cleanup. `REVIEWS.md` is now withheld when
the aggregate has zero lines (every lane failed, not merely skipped under a
lower budget), the run reports the failure instead, and per-lane outputs and
non-empty `.err` files are preserved beside the phase's artifacts before
cleanup runs.

**Unreadable directories are distinguished from absent ones (#3473 B5).**
Four call sites collapsed an `EACCES`/`EIO` on a phase directory into the
same "nothing here" result as a directory that genuinely does not exist —
`countPhasePlansAndSummaries` (`hasContext:false`), `runGapAnalysis`, and two
guarded blocks in `init.cts` (`context_path` absent). Each now distinguishes
"could not read" from "does not exist" and names the discarded path and
error in a dedicated field (`context_read_error` / `phase_dir_read_error`)
rather than silently reading as absent.

**Audited, no defect found:** every retry-set / swallowed-catch call site
this phase's rule covers that had not already been fixed by a prior PR
(`withPlanningLock`, `acquireStateLock`, `atomicRenameWithRetry`,
`renameWithRetry`) was reviewed and found to already fail loudly on a fatal
errno rather than folding it into a retry.

**Known limits:**
- A match deeper than 48 levels is still not surfaced by `intel query` — it
  is reported as truncated rather than as absent, but the value itself is
  not returned. Raising the ceiling is a separate decision.
- `phase-plan-index`'s `waves` / `wave` fields remain computed from the
  degraded DAG when an edge is dropped — this phase stops the tool from
  manufacturing a false verdict about it, but does not invent the missing
  edge. A consumer that schedules work from `wave` (e.g. `--wave N`
  filtering) is still working from the degraded assignment.
- `review.md`'s evidence preservation is bounded by what a lane actually
  wrote — a lane that produced no output at all leaves nothing to preserve.

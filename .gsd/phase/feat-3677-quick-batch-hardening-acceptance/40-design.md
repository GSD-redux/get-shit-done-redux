# Phase 5 (#3677) design — quick-batch hardening and acceptance

Epic #3344, Phase 5 (final). Base: `origin/next` @ `114dfcb739` (Phases 1-4
merged: #4190 core primitives, #4212 command/workflow/isolation).

## 0. Provenance note

A prior research pass produced a design doc + test matrix in this same
directory, but its worktree was garbage-collected before those files were
committed (`.gsd/` is gitignored repo-wide; "no commits" was treated as "no
changes" by worktree auto-cleanup). This document is a from-scratch rebuild,
grounded in an independent re-read of the actual workflow steps and source,
not a transcription of the lost files. Where it agrees with the prior
agent's SUMMARY, that is re-verified agreement, not inherited trust.

## 1. Open Question 1 — crash-window duplicate dispatch (RESOLVED: real gap, fix proposed)

**Claim under test:** a coordinator crash between Step 6 (executor returns,
`SUMMARY.md` written, real commit in a real worktree) and Step 7 (merge)
leaves the item's `BATCH.json` status at `pending`, and `--resume` would
dispatch a SECOND executor into a NEW worktree for the same item, orphaning
the first.

**Trace performed independently** (not reusing the prior agent's citations):

- `src/quick-batch.cts:894-899` — `resumeBatch`'s ONLY crash-window
  detection completes an item early via `hasQuickTaskRow(stateContent,
  it.quick_id)` — a check against `.planning/STATE.md`. The eligibility
  filter at `src/quick-batch.cts:926-928` is otherwise pure
  status/depends_on logic; it has no awareness of `PLAN.md`/`SUMMARY.md` on
  disk.
- `gsd-core/workflows/quick-batch/steps/completion.md:1-8` — confirms
  `completeQuickItem` (Step 9) is "the ONLY writer of a 'Quick Tasks
  Completed' STATE.md row" — i.e. the STATE.md row `hasQuickTaskRow` checks
  for is written only AFTER Step 7 (merge) and, when `--validate`, Step 8
  (verification) both succeed. A crash between Step 6 and Step 7 crashes
  before any STATE.md row exists, so `resumeBatch`'s only recovery signal
  never fires for this window.
- `gsd-core/workflows/quick-batch/steps/resume-mode.md:23-27,45-49` — on
  `--resume`, `eligible` items flow straight into the SAME per-round loop
  Step 3/planner-wave/worktree-dispatch use for a fresh batch — "the DAG-
  layer loop in `planner-wave.md` reads `$BATCH_MANIFEST_JSON`/`$BATCH_ID`
  exactly the same way whether this batch was just created or just resumed."
- `gsd-core/workflows/quick-batch/steps/planner-wave.md:15-19` — the
  planning loop's eligibility for THIS layer is `status == "pending"` AND
  `${item_dir}/${quick_id}-PLAN.md` does **not** yet exist on disk. An item
  whose PLAN.md already exists (planned before the crash) is correctly
  skipped here — planning is NOT re-run. This is the file-existence guard
  the prior summary described as absent; it is present, but only at the
  PLANNING layer.
- `gsd-core/workflows/quick-batch/steps/worktree-dispatch.md:29-59` (Step 6,
  "Dispatch rounds") — re-derives eligibility every round via `quick-batch
  resume --batch "$BATCH_ID" --raw` (same primitive as above, same blind
  spot), then spawns an executor for every item in `$spawn` (backpressure-
  limited `eligible`). **There is no analogous check here for "does
  `${item_dir}/${quick_id}-SUMMARY.md` already exist" before spawning.** The
  only SUMMARY.md check in this file is AFTER dispatch, at
  `worktree-dispatch.md:118-121` ("After every item dispatched this round
  returns: verify SUMMARY.md exists") — too late to prevent the duplicate
  dispatch itself, and it doesn't even apply here since the crashed
  coordinator never issued this round's dispatch in the first place; a NEW
  coordinator process re-deriving eligibility from scratch has no round
  history to consult.
- `gsd-core/workflows/quick-batch/steps/merge-wave.md:10-15` (Step 7) — its
  OWN mergeable-wave criterion is independent of the `eligible`/`spawn` list
  entirely: "items that are `status == 'pending'` with a `SUMMARY.md` on
  disk... and NOT yet merged." This is correct and sufficient FOR MERGE — it
  would find and merge the original (first) worktree's completed work fine,
  IF nothing else raced it. The bug is that Step 6 runs before Step 7 in
  every pass (including a resumed one) and would try to spawn a second
  executor for the same item first.

**Conclusion: CONFIRMED REAL.** Nothing in the resume/dispatch path checks
for a pre-existing `SUMMARY.md` before dispatching an executor. An item that
crashed after Step 6 but before Step 9's STATE.md write is indistinguishable,
to `worktree-dispatch.md`'s dispatch loop, from an item that was never
started — it re-enters `$spawn` and gets a brand-new `git worktree add` +
`gsd-executor` dispatch. The original worktree (with its real commit and
`SUMMARY.md`) is never referenced again by anything — not cleaned up, not
merged via its own record, simply orphaned. If both executors happen to
run to completion, Step 7's merge-eligibility check (`SUMMARY.md` exists on
disk, "not yet merged") only knows about ONE `$item_dir` per `quick_id`
(directories are keyed by `quick_id`+slug, not by worktree), so the SECOND
executor's `SUMMARY.md` write clobbers the first at the same path, and only
the SECOND worktree's `WT_PATH`/`WT_BRANCH` (recorded in
`$QUICK_BATCH_WORKTREE_MANIFEST` under the second dispatch's `agent_id`) is
ever merged — the FIRST worktree's real, already-committed work is never
merged, never cleaned up, and never surfaced as an error. This is a silent
work-loss bug, not merely a resource leak.

**Proposed fix (confidence: HIGH — narrow, mechanical, directly mirrors an
existing, already-reviewed pattern in the same file family):**

Add a SUMMARY.md-existence exclusion to `worktree-dispatch.md`'s Step 6,
substep 1 (the per-round eligibility re-derivation), symmetric to
`planner-wave.md`'s PLAN.md-existence exclusion: after parsing `eligible`
from `quick-batch resume`, drop any `quick_id` whose
`${item_dir}/${quick_id}-SUMMARY.md` already exists on disk from the set
passed to `spawn-plan` (never dispatch it) — those items fall through
untouched to Step 7, whose own mergeable-wave criterion already picks them
up correctly by the same file check. This is a workflow-layer (prose/bash)
fix, not a change to `resumeBatch` or any other already-merged, already-
reviewed `.cts` module — see rejected alternatives below for why.

**Fix location decision — workflow layer, not `resumeBatch` core primitive:**
`resumeBatch` (`src/quick-batch.cts:863-939`) is a shared primitive called
from two call sites with different needs (`resume-mode.md`'s one-shot resume
report AND `worktree-dispatch.md`'s per-round re-derivation). Teaching
`resumeBatch` about `${item_dir}/${quick_id}-SUMMARY.md` paths would require
it to either accept a slug-generation dependency it doesn't currently have,
or have its `eligible` return value silently diverge in meaning between the
two callers (a `resume-mode.md` "eligible" count that excludes
in-flight-but-uncommitted-to-merge items reads correctly for a resume
report; a "the item exists in $item_dir so don't re-plan/re-dispatch it"
check is a workflow-execution concern). Filtering in
`worktree-dispatch.md`, immediately before the existing `spawn-plan` call,
keeps the fix local to the one place that actually dispatches executors,
touches zero already-reviewed `.cts` files, and is directly analogous to
the file-existence check `planner-wave.md` already does one step earlier in
the same pipeline for the same reason.

## 2. Coverage table (#3677 acceptance criteria → status)

| # | AC bullet (verbatim, abbreviated) | Existing coverage | Gap | Action |
|---|---|---|---|---|
| 1 | Security: traversal, symlink escape, special files, prompt-injection, shell-metacharacter task text, manifest tampering, **arbitrary-worktree ownership attempts** | `tests/quick-batch.test.cjs` + `tests/quick-batch.property.test.cjs` cover traversal/symlink/special-file `--file` rejection (Phase 3/4 `60-review.json` fixed real findings); `gsd-quick-batch-workflow.test.cjs` covers the DATA_START/DATA_END prompt-injection boundary and quoted `$ARGUMENTS`. **Arbitrary-worktree-ownership tampering is NOT covered** — no test constructs a cleanup-wave manifest entry naming a worktree path/branch this batch never created. | Real gap | New hostile test |
| 2 | Capacity precedence/backpressure | `quick-batch-dispatch.test.cjs` + `.property.test.cjs` cover `effective-concurrency`/`spawn-plan` exhaustively (Phase 3). | None found | none |
| 3 | Scheduling: cycles, unknown deps, deterministic waves, isolation modes, serialized lifecycle, deterministic merge, conflicts, **scope drift**, stale bases, **submodules** | `quick-batch.test.cjs`/`.property.test.cjs` cover cycle/unknown-dep rejection and wave determinism. `gsd-quick-batch-merge-integration.test.cjs` covers a real merge conflict and a real undeclared deletion end-to-end. `worktree-safety.test.cjs:5716-6313` covers the `.gitmodules`/`SUBMODULE_PATHS` isolation-disable gate and the executor's own pre-commit submodule guard extensively — but always in the `execute-phase`/`quick.md` context, never through quick-batch's OWN merge/cleanup call path with a real `.gitmodules` file in the repo. `planWaveScopeConformance` (`src/worktree-safety.cts:921-...`) is unit-tested for its advisory `SCOPE_OUT_OF_DECLARED` warning, but not exercised end-to-end through a real git diff via `executeWorktreeWaveCleanupPlan`/`worktree.cleanup-wave` the way merge_failed/scope_violation already are. | Two real gaps | New real-git submodule integration test; new real-git advisory scope-drift test |
| 4 | Fault-injection: every durable manifest/STATE crash window, resume exactly-once | STATE-row crash window (Step 9) is covered. **The Step-6→Step-7 crash window (this doc §1) was UNCOVERED and is the one genuine functional gap in this phase.** | Real gap (now understood + fixed) | Fix + regression test |
| 5 | Outcome propagation (blocked/independent-continue) | Covered by `resumeBatch`'s blocked-propagation fixed-point tests and `quick-batch-dispatch.test.cjs`'s routing tests. | None found | none |
| 6 | Docs: v1 limits (`--discuss`/`--full`, no gap-fix loop, `none`=sequential) | `docs/how-to/batch-quick-tasks.md` states all of these already (lines 52-55, 74, 113). | None found | none |
| 7 | Generated artifact sync (command/skill/registry/inventory/matrix/install-tree) | Enforced by existing repo-wide generated-sync lint (not quick-batch-specific); Phase 4 already ran `regen:derived`. | None found (no new command surface added this phase) | none |
| 8 | `/gsd:quick` regression + quick-ID grammar green | `gsd-quick-batch-quick-regression.test.cjs` exists explicitly for this. | None found | none |
| 9 | Docs: preserved-worktree diagnosis | `docs/how-to/batch-quick-tasks.md:114` — exactly one sentence ("its worktree is preserved (never deleted) so you can inspect what happened"), no path, no diagnostic steps, no recovery procedure. | Real gap (thin, not absent) | Doc extension |
| 10 | Final acceptance evidence mapped to #3344 | Not yet produced this phase. | Real gap | New doc artifact |
| 11 | RED/GREEN/REFACTOR commit discipline, closes #3677 only | Process requirement, not a test | N/A | Followed in implementation |

## 3. Prior-art grounding for new tests

- Hostile worktree-ownership test: follows the REAL-git-fixture pattern
  already established by `tests/gsd-quick-batch-merge-integration.test.cjs`
  (`initRepo`/`addWorktree`, real `executeWorktreeWaveCleanupPlan`,
  `WORKTREE_AGENT_BRANCH_RE` branch-name validation already enforced at
  `src/worktree-safety.cts:512`) — a manifest entry naming a path/branch
  never created by this batch (e.g. a sibling repo's worktree, or a
  plausible-looking but foreign branch) must be rejected/blocked, never
  merged or deleted.
- Advisory scope-drift test: exercises `planWaveScopeConformance`
  (`src/worktree-safety.cts:921-...`, `WAVE_CLEANUP_WARNING.SCOPE_OUT_OF_DECLARED`
  at `:879-884`) end-to-end through a REAL git diff via
  `executeWorktreeWaveCleanupPlan`, mirroring the merge-conflict/undeclared-
  deletion pattern in `gsd-quick-batch-merge-integration.test.cjs` — commit a
  path outside `files_modified` and assert the merge still SUCCEEDS
  (advisory, never blocking) while a warning with the frozen code is
  produced.
- Submodule integration test: reuses `writeGitmodulesWithSubmodule`'s
  fixture shape from `tests/worktree-safety.test.cjs:5879-5886` but drives
  it through the quick-batch merge/cleanup call path
  (`executeWorktreeWaveCleanupPlan`) instead of the isolation-decision gate
  that file already covers — proves a repo containing `.gitmodules` merges
  cleanly through quick-batch's own primitive when the plan doesn't touch
  the submodule path, and that a plan touching the submodule path still
  merges (worktree isolation's own submodule-intersection gate is a
  separate, already-covered pre-dispatch decision, not a merge-time block).
- Crash-window regression test: structural assertion on
  `worktree-dispatch.md`'s prose, following the SAME established convention
  `tests/gsd-quick-batch-workflow.test.cjs` already uses for every other
  workflow-file behavior (e.g. its own "planner-wave.md marks a missing
  PLAN.md item failed" test at line 253-256) — this repo's blessed pattern
  for testing markdown-as-source (see that file's own header comment,
  lines 16-21).

## 4. Not-corruption

None of the new tests duplicate existing coverage:
- The merge-conflict/undeclared-deletion real-git tests already in
  `gsd-quick-batch-merge-integration.test.cjs` are untouched; the new tests
  add sibling `describe` blocks for DIFFERENT manifest-entry shapes
  (foreign ownership, out-of-scope-but-declared-nothing-wrong path,
  submodule-bearing repo) using the same helpers, not modifying existing
  assertions.
- `worktree-safety.test.cjs`'s extensive `.gitmodules` coverage (isolation
  ENABLE/DISABLE decision, executor pre-commit shell guard) is left
  entirely alone — the new test targets a different function
  (`executeWorktreeWaveCleanupPlan`, the merge primitive) that file never
  exercises with a `.gitmodules` fixture.
- The crash-window fix touches only `worktree-dispatch.md`; it does not
  modify `resumeBatch`, `planner-wave.md`, or `merge-wave.md`, all of which
  keep their existing, already-reviewed behavior and tests unchanged.

## 5. Blast radius

- `gsd-core/workflows/quick-batch/steps/worktree-dispatch.md` — additive
  SUMMARY.md-existence filter, Step 6 substep 1 only.
- `tests/gsd-quick-batch-workflow.test.cjs` — one new `describe` block
  (structural regression test for the filter above).
- `tests/gsd-quick-batch-merge-integration.test.cjs` — new `describe`
  blocks: worktree-ownership tampering, advisory scope-drift, submodule
  integration.
- `docs/how-to/batch-quick-tasks.md` — extend the "Resuming and failure
  recovery" section with a preserved-worktree diagnosis subsection.
- New doc artifact: `.gsd/phase/feat-3677-quick-batch-hardening-acceptance/60-acceptance-evidence.md`
  mapping every #3344 AC bullet to its evidence.
- No `src/*.cts` production module changes required — the one functional
  fix lands entirely in workflow prose.

## 6. Laws (invariants that must keep holding)

- Single-writer invariant (STATE.md/BATCH.json/ROADMAP.md owned only by the
  coordinator) — untouched.
- `resumeBatch`'s existing crash-window detection (STATE.md row) and
  blocked/failed propagation fixed-point — untouched, still the sole
  authority for `complete`/`blocked` transitions.
- Merge scope validation (`partitionDeclaredDeletions`,
  `planWaveScopeConformance`) stays advisory-for-scope /
  blocking-for-undeclared-deletion exactly as already implemented — the new
  scope-drift test asserts this distinction, it does not change it.
- `WORKTREE_AGENT_BRANCH_RE` remains the sole gate on what counts as a
  batch-owned branch name — the ownership-tampering test asserts against
  this existing regex, does not introduce a second one.

## 7. Rejected alternatives

1. **Fix the crash window inside `resumeBatch`** (teach it about
   `SUMMARY.md`/item directories). Rejected — see §1 fix-location decision;
   would touch already-merged, already-reviewed code for a fix whose
   natural home is one step later in the pipeline, and would overload
   `resumeBatch`'s single-purpose eligibility contract for two callers with
   different needs.
2. **Mark the item `blocked`/`human_needed` when SUMMARY.md exists but
   status is still `pending`.** Rejected — this is not a failure or an
   ambiguous state; it's a known, recoverable mid-flight condition. Silently
   skipping re-dispatch and letting Step 7's existing merge criterion pick
   it up is strictly less invasive and requires no new status value or
   routing branch.
3. **Add a lock file per in-flight worktree instead of a file-existence
   check.** Rejected — `SUMMARY.md`'s existence already IS the durable,
   crash-safe signal (it's written by the executor as its last real action,
   same as everywhere else in this design uses artifact-existence over
   process state); a separate lock file adds a second source of truth that
   itself needs crash-recovery semantics.
4. **Skip the submodule/scope-drift/ownership tests as "already implied" by
   unit-level coverage.** Rejected per this repo's own established
   pattern (`gsd-quick-batch-merge-integration.test.cjs`'s own header
   comment): pure-function assertions on `routeMergeOutcome`/
   `planWaveScopeConformance` were previously judged insufficient without a
   REAL git fixture proving the underlying primitive agrees; the same
   standard applies to the three new gaps here.

## 8. Known limits (v1, documented, not fixed here)

- A crash DURING Step 7 (merge in progress) still relies on
  `executeWorktreeWaveCleanupPlan`'s own mid-merge halt behavior
  (`merge-wave.md:56-59`) — unchanged by this phase, already covered by
  Phase 3/4's own worktree-safety suite.
- No automatic gap-fix retry after a `gaps_found` verification outcome
  (documented v1 exclusion, unchanged).
- The new SUMMARY.md-existence filter does not distinguish "crashed after
  writing SUMMARY.md" from "executor is still mid-write" (a partial file);
  this is the same trust boundary the rest of the pipeline already accepts
  (`worktree-dispatch.md:118-121`'s own post-dispatch check treats
  SUMMARY.md existence as the completion signal, no partial-write handling
  anywhere in this design).

## 9. Review Pass 2 addendum — orthogonal Spec + Security findings, both closed

Two isolated review passes (neither authored the original diff) found two
real test-quality gaps in §1's implementation and the ownership-tampering
tests in §3. Both are closed here, WITHOUT deferral, per this repo's
absolute no-defer rule — including a THIRD, self-discovered defect surfaced
while fixing the first finding (see §9.3).

### 9.1 Spec finding — crash-window test was a prose proxy, not behavioral proof

The original `tests/gsd-quick-batch-workflow.test.cjs` regression tests for
§1's fix only asserted `readStep('worktree-dispatch.md')` + regex matches
against the MARKDOWN — proving the documentation says the right thing,
never that the runtime condition (pending status + on-disk SUMMARY.md +
absent STATE row) is actually handled correctly. #3677's own "Alternatives
considered" explicitly rejects "document recovery without fault injection."

**Fix:** the filtering decision itself — "drop items whose SUMMARY.md
exists from the eligible-for-dispatch set" — is now a pure, independently
testable function, `filterAlreadyExecuted(eligibleIds, executedIds)` in
`src/quick-batch-dispatch.cts`, wired to a new `quick-batch filter-executed`
CLI verb (`src/quick-batch-command-router.cts`), following the SAME
pure-decision-then-CLI-wired pattern `computeSpawnPlan`/`computeMergeOrder`
already establish in that module. `worktree-dispatch.md` now calls this
verb explicitly instead of describing the decision only in prose.

A genuine fixture-based test in `tests/quick-batch.test.cjs` (new describe
block "crash-window duplicate-dispatch guard (#3677)") constructs a REAL
`BATCH.json` via `createBatch`, writes a REAL `SUMMARY.md` file on disk at
the item's real `item_dir` (via `generateSlugInternal`, the same slug
derivation every workflow step uses), calls the REAL `resumeBatch`, and
proves `resumeBatch` alone still reports the item eligible — then proves
`filterAlreadyExecuted`, fed a real filesystem check, correctly excludes
it. A second test proves an item with no real SUMMARY.md is NOT excluded
(boundary case — the guard must not over-fire). The prior prose-assertion
tests are KEPT (they still prove the workflow markdown is correctly WIRED
to call the new verb, in the right order) but are no longer the only proof.
Pure-function boundary tests (empty/all-executed/order-preserving/Set vs
array/phantom-id) live in `tests/quick-batch-dispatch.test.cjs`; CLI-wiring
tests live in `tests/quick-batch-command-router.test.cjs`.

### 9.2 Security finding — ownership-tampering tests didn't test ownership

The original two tests (branch-name-fails-shape-check; wholly-foreign
never-registered repo) proved real things, but neither exercised what
"arbitrary-worktree ownership" actually names: a manifest entry whose
`worktree_path`/`branch` are swapped to point at a DIFFERENT,
GENUINELY-REGISTERED sibling worktree of the SAME `repoRoot` (a concurrent
batch's own agent worktree, or a stale worktree from a prior crashed run),
with a branch name that passes `WORKTREE_AGENT_BRANCH_RE`'s shape check and
a base that is legitimately in `allowed_bases`.

**Investigation conclusion: ALREADY SAFE — not a reachable gap.** Traced
`executeWorktreeWaveCleanupPlan` (`src/worktree-safety.cts:1005-1217`)
directly against two REAL, concurrently-alive sibling worktrees of one
repo. Git itself enforces branch-per-worktree uniqueness — the same branch
cannot be checked out in two worktrees of one repo at once — so
`worktree_path`'s ACTUAL checked-out branch
(`git -C worktree_path rev-parse --abbrev-ref HEAD`, `:1047`) can only
equal a swapped-in `entry.branch` if that `entry.branch` is the SIBLING's
own real, uniquely-generated branch name. Manifest tampering confined to
ONE batch's own record has no way to know that name: branch names are
`agent-<quick_id>[-<timestamp>]`-shaped (`execute-phase`'s own
`executor-isolation-dispatch.md:269-270` convention, reused verbatim per
`worktree-dispatch.md`'s own text), and `quick_id` allocation is
collision-checked GLOBALLY across every existing quick task AND batch
(`src/quick-batch.cts` `collectExistingBatchQuickIds`) — not merely
within one batch. Constructing a passing swap therefore requires ALSO
having legitimate read access to the sibling's own worktree/branch record,
which is a strictly larger compromise than "tamper with this batch's own
manifest," the scope the AC bullet actually names.

Empirically verified (not merely reasoned about) with two real
`git worktree add`-created siblings sharing one merge-base: a manifest
entry naming item 2's real path but item 1's real branch name (the direct
swap), and the reverse, both come back `status: 'blocked',
reason: 'branch_mismatch'` — never `merge_failed`, never a wrongly
successful merge. Both real worktrees, their branches, and item 2's real
uncommitted-to-main commit survive completely untouched by either attempt.

**Fix:** a new, stronger test in `tests/gsd-quick-batch-merge-integration.test.cjs`
("a manifest entry with one sibling worktree's real PATH but the OTHER
sibling's real BRANCH name is blocked") supplements (does not replace) the
original two tests, which still prove real, distinct boundaries
(branch-shape rejection at the manifest-normalization layer; a wholly
foreign, never-registered repo blocked via `base_mismatch`).

**Explicitly documented trust boundary (not a gap, not fixed):**
`executeWorktreeWaveCleanupPlan` defends against fabricated/mismatched
`{worktree_path, branch, base}` triples; it does NOT defend against a
CALLER bug that correctly copies a real-but-wrong-item's triple into the
wrong manifest entry (i.e. gets `agent_id` attribution wrong while every
git-verifiable field is internally consistent for SOME real worktree). This
is why §9.3's durable `dispatched_worktree`/`dispatched_branch`/
`dispatched_base` fields are stored PER quick_id (a direct keyed lookup),
never via a shared array requiring an `agent_id`-matching search — the
storage shape itself avoids the one class of caller-side attribution bug
this primitive cannot see.

### 9.3 Self-discovered defect (not deferred) — durable worktree recovery was missing entirely

While building §9.1's real fixture, tracing `merge-wave.md` substep 3
("`$WT_PATH`/`$WT_BRANCH`/`$EXPECTED_BASE` per item come from the recorded
`$QUICK_BATCH_WORKTREE_MANIFEST` entry Step 6 wrote for that `agent_id`")
against `/gsd:quick`'s own prior art (`gsd-core/workflows/quick.md:415`:
`QUICK_WORKTREE_MANIFEST=$(mktemp ...)`) revealed that
`$QUICK_BATCH_WORKTREE_MANIFEST` — quick-batch explicitly models it on the
SAME mechanism — is a fresh, PER-PROCESS `mktemp` file, not a durable
record. §1's own fix (never re-dispatch an item whose SUMMARY.md already
exists) means a RESUMED coordinator process's Step 6 correctly does NOT
create a fresh manifest entry for that item — but nothing else durably
recorded that item's `worktree_path`/`branch`/`expected_base` either, so
Step 7 in the resumed process would have had NO data to build that item's
cleanup-wave entry from. §1's original claim ("not lost: merge-wave.md's
own criterion already picks it up") was therefore ACCURATE about
merge-eligibility ("should this item be merged") but WRONG about data
availability ("with what worktree/branch"). Before §1's fix, this never
surfaced as a visible bug because the old (harmful) re-dispatch behavior
always populated a fresh manifest entry for whichever (wrong, duplicate)
worktree it just created — the durable-recovery gap was latent, masked by
the duplicate-dispatch bug itself.

**Fix:** three new fields on `QuickBatchItem`
(`dispatched_worktree`/`dispatched_branch`/`dispatched_base`,
`src/quick-batch.cts`) — deliberately NOT a reuse of the pre-existing
`worktree` field, whose `loadBatch` validation requires the path to exist
on disk (verified empirically: reusing it made the batch permanently
unloadable the moment a legitimately-merged worktree was removed, since
`updateBatchItems` itself calls `loadBatch` first). The three new fields
carry no existence check — their entire purpose is to stay readable (and
clearable) after a legitimate post-merge removal. `updateBatchItems`
(`QuickBatchItemUpdate`) gained matching optional `dispatchedWorktree`/
`dispatchedBranch`/`dispatchedBase` fields (explicit `null` clears,
`undefined` leaves untouched — same convention as `dependsOn`/
`plannedFiles`). `worktree-dispatch.md` persists the triple immediately
after recording the ephemeral entry; `merge-wave.md` falls back to it when
the ephemeral manifest lacks an entry, clears it after a successful merge,
and fails closed (`merge_failed: "missing durable worktree record"`) rather
than guessing if somehow all three are still null.

Verified end-to-end (persist → fresh `loadBatch` recovers the triple →
clear → a SUBSEQUENT `loadBatch` still succeeds even though the path no
longer exists) in `tests/quick-batch.test.cjs`'s new "durable
worktree-recovery fields (#3677)" describe block, plus structural wiring
tests in `tests/gsd-quick-batch-workflow.test.cjs` for both workflow files.

### 9.4 Revised blast radius (supersedes §5 for the fields below)

- `src/quick-batch.cts` — `QuickBatchItem`/`QuickBatchItemInput`/
  `QuickBatchItemUpdate` gain `dispatched_worktree`/`dispatched_branch`/
  `dispatched_base` (+ camelCase input/update equivalents);
  `validateBatchSchema` gains matching type checks (no existence check).
- `src/quick-batch-dispatch.cts` — new `filterAlreadyExecuted` pure
  function + `FilterAlreadyExecutedResult` type.
- `src/quick-batch-command-router.cts` — new `filter-executed` CLI verb.
- `gsd-core/workflows/quick-batch/steps/worktree-dispatch.md` — the guard
  now calls `quick-batch filter-executed` instead of describing the split
  only in prose; a new durable-persistence step after recording the
  ephemeral manifest entry.
- `gsd-core/workflows/quick-batch/steps/merge-wave.md` — durable fallback
  for `$WT_PATH`/`$WT_BRANCH`/`$EXPECTED_BASE`; clears the triple on a
  successful merge; fails closed when no record exists anywhere.
- Test files: `tests/quick-batch.test.cjs`, `tests/quick-batch-dispatch.test.cjs`,
  `tests/quick-batch-command-router.test.cjs`,
  `tests/gsd-quick-batch-workflow.test.cjs`,
  `tests/gsd-quick-batch-merge-integration.test.cjs` — all gain new,
  independently-verified (real fixture / real git, not merely prose-proxy)
  coverage per §9.1-9.3.
- §5's "No `src/*.cts` production module changes required" is SUPERSEDED —
  three `.cts` modules changed, all additive (new fields/functions/verbs,
  zero changes to existing field shapes, existing function signatures, or
  existing CLI verb behavior).

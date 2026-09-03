# Final acceptance evidence — epic #3344 (`/gsd:quick-batch`)

Maps every acceptance-criterion bullet in #3344 to its evidence. Phases 1-4
(#4190, #4212, and their prerequisite dispatch/wave-partitioner PRs) are
cited by test file — those PRs' own `60-review.json` verdicts are the
authoritative record for anything not re-verified in this phase. Phase 5
(#3677, this PR) entries are marked **NEW** and cite the file/test added
here. #3344 itself stays OPEN after this PR merges, per its own instruction
("Epic #3344 closes only after final maintainer acceptance") — this table
is the evidence submitted for that acceptance, not a closure action.

## Command and artifacts

| AC bullet | Evidence |
|---|---|
| Accepts ≥2 inline tasks or a validated repo-relative task file | `tests/quick-batch.test.cjs` (`parseTaskList`/`parseTaskListFromFile`), `tests/gsd-quick-batch-workflow.test.cjs` |
| `--jobs auto\|N`, `--validate`, `--research`, `--resume <batch-id>` documented | `commands/gsd/quick-batch.md` frontmatter tests; `docs/how-to/batch-quick-tasks.md` "Flags" |
| V1 rejects `--discuss`/`--full` before dispatch | `tests/gsd-quick-batch-workflow.test.cjs` "objective documents --discuss/--full as rejected" |
| No automatic broad-prompt decomposition | `docs/how-to/batch-quick-tasks.md` "Basic use" (explicit list only) |
| Collision-safe quick ID/directory even for duplicates | `tests/quick-batch.test.cjs` (`allocateQuickIds`/`allocateIdsGivenUsed`), `quick-batch.property.test.cjs` |
| Normal quick PLAN + `status: complete` SUMMARY under `.planning/quick/`, audit-scanner-recognized | `tests/gsd-quick-batch-quick-regression.test.cjs` |
| Batch control state under `.planning/quick-batches/<batch-id>/`, not a fake quick dir | `tests/quick-batch.test.cjs` (`createBatch`/`batchManifestPath`) |
| Coordinator dispatches leaves directly; no child invokes `/gsd:quick`; no nested/background delegation required | `tests/gsd-quick-batch-workflow.test.cjs` "single-writer invariant on the executor" (`NEVER invoke /gsd:quick`) |

## Capacity and scheduling

| AC bullet | Evidence |
|---|---|
| Normalized worker-capacity signal; `dispatch-capacity` single consumer | Phase 1/2 (#3673/#3674) host-integration + `quick-batch-dispatch.test.cjs` |
| Effective concurrency bounded by task count / `--jobs` / capacity | `tests/quick-batch-dispatch.test.cjs`, `.property.test.cjs` (`effective-concurrency`) |
| Missing/invalid/zero/negative/`undocumented` capacity fails closed to 1 | `tests/quick-batch-dispatch.test.cjs` |
| No runtime-name literal branches in scheduler | `src/quick-batch.cts`/`src/quick-batch-dispatch.cts` — no `RUNTIME ===`/`runtime name` conditionals (grep-verified during Phase 3/4 review) |
| Backpressure preserves pending state, never overspawns | `tests/quick-batch-dispatch.test.cjs` (`spawn-plan`) |
| Declared dependencies honored; overlapping file sets never co-wave | `tests/quick-batch.test.cjs` (`computeWaves`), `.property.test.cjs` |
| Independent non-overlapping tasks run concurrently when capacity allows | `tests/quick-batch.test.cjs` wave tests |
| Deterministic wave/merge ordering for identical input | `tests/quick-batch.test.cjs` + `tests/gsd-quick-batch-merge-integration.test.cjs` (wave-order-preserving merge) |

## Isolation and Git safety

| AC bullet | Evidence |
|---|---|
| `harness-worktree`/`orchestrator-worktree`/`none` each behaviorally tested, fail-closed degradation | `tests/gsd-quick-batch-workflow.test.cjs` "isolation model coverage"; `gsd-core/workflows/quick-batch/steps/worktree-dispatch.md` (row 38 stale-base auto-degrade) |
| Mutating wave forced to 1 worker when isolation is `none` | `tests/quick-batch-dispatch.test.cjs` (`--mutating` forcing) |
| Worktree create/merge/cleanup serialized and manifest-scoped; never sweeps/deletes an unowned worktree | `tests/gsd-quick-batch-merge-integration.test.cjs` — **NEW/REVISED (review pass 2)**: "arbitrary-worktree ownership tampering" describe block, 3 tests: (1) tampered branch name silently dropped at normalization; (2) foreign, never-registered repo blocked via base_mismatch; (3) the STRONGER proof — two REAL, concurrently-alive sibling worktrees of the SAME repo, path/branch swapped between them, blocked via branch_mismatch in both directions, both survive untouched. Investigation concluded the swap is not a reachable gap (git's own branch-per-worktree uniqueness + globally collision-checked quick_id-derived branch names) — see `40-design.md` §9.2. |
| Later waves start from the current merged batch base | `gsd-core/workflows/quick-batch/steps/merge-wave.md` Step 7 design; `tests/quick-batch.test.cjs` wave recompute tests |
| Merge applies committed-diff-vs-declared-scope validation; reports scope drift without silently merging it | `tests/gsd-quick-batch-merge-integration.test.cjs` (undeclared-DELETION blocking, Phase 4) **+ NEW**: "advisory scope drift merges but warns" describe block (drift produces `scope_out_of_declared` warning + still merges; exact-match boundary case produces zero warnings) |
| Child workers never concurrently switch the main checkout; ≤1 aggregate branch | `gsd-core/workflows/quick-batch/steps/worktree-dispatch.md` "ONE AT A TIME" serialization test |
| Each merged item retains atomic implementation commit history | `tests/gsd-quick-batch-merge-integration.test.cjs` (`--no-ff` real-git merges preserve commit history) |
| Base divergence, merge conflict, stale worktree, submodule-touch, interrupted cleanup produce recoverable diagnostics | Base divergence: `resumeBatch`'s `currentBaseRevision` check (`tests/quick-batch.test.cjs`). Merge conflict: `tests/gsd-quick-batch-merge-integration.test.cjs` (Phase 4). Stale worktree / interrupted cleanup: `worktree-safety.test.cjs`'s existing mid-merge halt coverage (unchanged this phase) + `docs/how-to/batch-quick-tasks.md` **NEW** "Diagnosing a preserved worktree" subsection. Submodule-touch: `tests/gsd-quick-batch-merge-integration.test.cjs` **NEW** ".gitmodules submodule integration" describe block (3 tests: unrelated plan merges cleanly with `.gitmodules` present; a real gitlink pointer bump merges and the superproject tree reflects the new pinned commit; an undeclared bump is advisory-only and surfaces a `vendor/sub` scope warning) |

## State, failure, and resume

| AC bullet | Evidence |
|---|---|
| Leaves cannot write shared STATE.md/ROADMAP.md; coordinator is sole writer | `tests/gsd-quick-batch-workflow.test.cjs` single-writer invariant test |
| Completed rows appended atomically, exactly once, including after resume | `src/quick-batch.cts` `completeQuickItem`/`hasQuickTaskRow`; `tests/quick-batch.test.cjs` idempotency tests |
| Failure of one item doesn't roll back others | `tests/quick-batch-dispatch.test.cjs` routing isolation tests; `worktree-safety.cts`'s `#2852` per-entry isolation (`blockEntry`/`continue`) |
| Failed item recorded failed; dependents recorded blocked; unrelated pending continue | `tests/quick-batch.test.cjs` `resumeBatch` blocked-propagation fixed-point tests |
| `--resume` skips complete, retries only eligible non-complete, idempotent | `tests/quick-batch.test.cjs` `resumeBatch` tests **+ NEW fix**: `gsd-core/workflows/quick-batch/steps/worktree-dispatch.md` Step 6 substep 1 crash-window guard (a `pending` item whose `SUMMARY.md` already exists on disk — executor finished, coordinator crashed before Step 7's merge — is no longer re-dispatched into a second worktree on `--resume`; it falls through to Step 7's existing SUMMARY.md-on-disk merge criterion instead). Regression-tested structurally in `tests/gsd-quick-batch-workflow.test.cjs` "crash-window duplicate-dispatch guard" describe block (3 tests: guard text present, guard positioned before `spawn-plan` is computed, guard documents the merge-wave.md recovery path). **This was the one genuine functional gap found in this phase** — see `.gsd/phase/feat-3677-quick-batch-hardening-acceptance/40-design.md` §1 for the full trace. |
| Invalid/corrupt batch manifest fails closed, no guessing | `tests/quick-batch.test.cjs` `loadBatch` malformed-JSON tests |

## Security, portability, and project quality

| AC bullet | Evidence |
|---|---|
| `--file` rejects traversal/symlink-escape/special files/outside-root; task text untrusted in prompts | `tests/quick-batch.test.cjs`/`.property.test.cjs` (Phase 3/4 review-fixed findings); `tests/gsd-quick-batch-workflow.test.cjs` DATA_START/DATA_END boundary tests |
| Paths with spaces, duplicate slugs, Windows separators, BSD/GNU differences, non-ASCII descriptions | `tests/quick-batch.test.cjs`/`.property.test.cjs` (slug generation, cross-platform path tests) |
| Workflow stays within size budget via shared fragments | `tests/gsd-quick-batch-workflow.test.cjs` byte-size boundary describe block (NEW_FILE_CAP); this phase's `worktree-dispatch.md` addition re-verified at 9.8KB, well under cap |
| Capacity axis backward-compatible, fails closed when absent | Phase 1/2 host-integration descriptor tests |
| #2652/PR #2728 resolved; no `RUNTIME != "claude"` gate copied | `gsd-core/references/dispatch-isolation-gate.md` reuse (Phase 4 design) |
| Canonical command Markdown / generated skill byte-for-byte synced | Repo-wide generated-sync lint (unchanged this phase; no new command surface) |
| Utility-cluster/profile/surface/inventory/installer/generated-artifact/doc parity | Repo-wide parity tests (unchanged this phase) |
| TDD/failing-test-first; Markdown behavior tested where applicable | Every new test in this phase written RED-first per its own commit; `tests/gsd-quick-batch-workflow.test.cjs`'s established structural-assertion convention for workflow prose |
| `npm test`, `npm run lint:ci`, generated-sync, required platform lanes pass | Verified via `gsd-test` before this PR ships (not run as part of this dispatch — reported separately) |

## #3677's own acceptance criteria (this phase issue)

| AC bullet | Evidence |
|---|---|
| Security: traversal/symlink/special-file/prompt-injection/shell-metachar/manifest-tampering/**arbitrary-worktree-ownership** | Manifest tampering + arbitrary-worktree ownership: **NEW**, this phase (see table above). Rest: Phase 3/4, unchanged. |
| Capacity: precedence/modes/backpressure | Phase 3, unchanged (`quick-batch-dispatch.test.cjs`) |
| Scheduling/execution: cycles/unknown-deps/waves/capacity/isolation/lifecycle/merge-order/conflicts/**scope-drift**/stale-bases/**submodules** | Scope drift + submodules: **NEW**, this phase. Rest: Phase 3/4, unchanged. |
| Fault-injection: every durable manifest/STATE crash window, resume exactly-once | **NEW fix + test**, this phase (crash-window guard, see above) — the STATE-row crash window was already covered in Phase 3. Review pass 2 upgraded the regression test from a prose-only proxy to a real fixture (`tests/quick-batch.test.cjs`, real `BATCH.json`+`SUMMARY.md`+`resumeBatch`), extracted the decision into a pure `filterAlreadyExecuted` function + `quick-batch filter-executed` CLI verb, and closed a self-discovered follow-on gap (durable worktree-path/branch recovery for a resumed coordinator process — `dispatched_worktree`/`dispatched_branch`/`dispatched_base`). See `40-design.md` §9.1/§9.3. |
| Outcome propagation; blocked dependents; independent continuation | Phase 3, unchanged |
| Docs: v1 limits | Phase 4, unchanged (`docs/how-to/batch-quick-tasks.md`) |
| Generated artifact sync | Repo-wide, unchanged (no new command surface this phase) |
| `/gsd:quick` regression + quick-ID grammar green | `tests/gsd-quick-batch-quick-regression.test.cjs`, unchanged |
| Docs: **preserved-worktree diagnosis** | **NEW**, this phase — `docs/how-to/batch-quick-tasks.md` "Diagnosing a preserved worktree" subsection |
| Focused tests / `npm test` / `npm run lint:ci` / generated-sync / install / platform lanes green | Verified via `gsd-test` before this PR ships |
| Real-PR-number changeset; no hand-edited CHANGELOG | Added after PR creation, per repo convention |
| Final verification maps evidence to #3344 | This document |
| RED/GREEN/REFACTOR commits; closes #3677 only | This PR's commit history; PR body closes #3677, references #3344 without closing it |

# Phase 5 (#3677) test matrix

Companion to `40-design.md`. Only NEW tests this phase adds — pre-existing
coverage is cited in `40-design.md` §2/§3, not re-listed here.

| Row | Test file | Test name (abbreviated) | Proves | #3677 AC bullet | #3344 AC bullet |
|---|---|---|---|---|---|
| 1 | `tests/gsd-quick-batch-merge-integration.test.cjs` | "a manifest entry naming a worktree/branch this batch never created is blocked, never merged or deleted" | `executeWorktreeWaveCleanupPlan` rejects a cleanup-wave entry whose `branch` fails `WORKTREE_AGENT_BRANCH_RE`, or whose `worktree_path` was never actually created by `git worktree add` for this repo — real fixture, real git, asserts the foreign path/branch survives untouched | Security bullet: "arbitrary-worktree ownership attempts" | "the command never sweeps or deletes an unowned worktree" |
| 2 | `tests/gsd-quick-batch-merge-integration.test.cjs` | "a committed path outside declared files_modified merges successfully with an advisory SCOPE_OUT_OF_DECLARED warning, never blocked" | `planWaveScopeConformance`'s advisory (non-blocking) behavior holds end-to-end through a REAL git diff via `executeWorktreeWaveCleanupPlan` — distinguishes advisory scope drift from the blocking undeclared-DELETION case already covered | Scheduling bullet: "scope drift" | "reports scope drift without silently merging it" |
| 3 | `tests/gsd-quick-batch-merge-integration.test.cjs` | "a repo with `.gitmodules` and an unrelated plan merges cleanly through the quick-batch cleanup primitive" + "...and a plan touching the submodule path also merges (isolation-disable is a separate, already-covered pre-dispatch decision)" | `executeWorktreeWaveCleanupPlan` handles a real `.gitmodules`-bearing repo without special-casing gitlink entries (mode 160000) incorrectly as an undeclared deletion or scope violation | Scheduling bullet: "submodules" | "submodule-touch... paths produce recoverable diagnostics" |
| 4 | `tests/gsd-quick-batch-workflow.test.cjs` | "worktree-dispatch.md excludes an item whose SUMMARY.md already exists from this round's spawn set (crash-window duplicate-dispatch guard)" | Structural regression test: the Step-6→Step-7 crash window (design §1) cannot silently regress — asserts the new SUMMARY.md-existence filter text exists in the prose, mirroring the file's own established pattern for asserting `planner-wave.md`'s PLAN.md-existence filter | Fault-injection bullet: "every durable manifest/STATE crash window" | "Base divergence, merge conflict, stale worktree, submodule-touch, and interrupted cleanup paths produce recoverable diagnostics" |
| 5 | `docs/how-to/batch-quick-tasks.md` (doc, not test) | "Diagnosing a preserved worktree" subsection | Extends the one-sentence mention into: where the worktree lives, what to check (`git log`, `git status`, the item's `SUMMARY.md`), how to manually merge/discard, how to re-run `--resume` afterward | Docs bullet: "preserved-worktree diagnosis" | "Base divergence... produce recoverable diagnostics" |
| 6 | `.gsd/phase/feat-3677-quick-batch-hardening-acceptance/60-acceptance-evidence.md` (doc, not test) | Full AC-to-evidence mapping | Every #3344 AC bullet cited against the specific test/doc/commit that satisfies it | "Final verification maps evidence to every acceptance criterion in #3344" | (self) |

## Boundary coverage note

Row 1 (ownership tampering) exercises the boundary at the branch-name
regex: a NEAR-miss branch name (fails `WORKTREE_AGENT_BRANCH_RE` by one
character / wrong prefix) is the primary hostile case — the "arbitrary"
part of "arbitrary-worktree ownership attempts" means attacker-controlled
manifest content, not merely a wrong-but-well-formed path, so the test
constructs BOTH a plausible-but-foreign branch name (passes the regex, but
was never created by `git worktree add` in this fixture) and a
regex-rejected name, asserting each is handled (rejected, not silently
adopted).

Row 2 (scope drift) exercises limit-1/limit/limit+1 analogously to the
existing undeclared-deletion test's two-case (declared vs undeclared)
shape: `files_modified` declares path A only; the real commit touches A
(no warning), A+B (one warning, B), and touches ONLY B (declared list
non-empty but wrong — still advisory, still merges, still warns).

## Property-based testing note

No new `fast-check` property test is added this phase — `40-design.md` §2
found no bijective/parser/budget-limit contract among the new gaps (an
existing-fixture merge/cleanup primitive, a doc extension, and a structural
workflow-prose assertion). `quick-batch.property.test.cjs` and
`quick-batch-dispatch.property.test.cjs` already carry this epic's `fast-check`
coverage for the parsing/budget/wave-partition contracts these new tests
build on top of; none of that is touched or needs new properties.

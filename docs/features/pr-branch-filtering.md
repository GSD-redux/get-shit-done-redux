---
id: 45
title: PR Branch Filtering
group: v1.27 Features
---

**Command:** `/gsd-pr-branch [target branch]`

**Purpose:** Create a clean branch suitable for pull requests by filtering out `.planning/` commits. Reviewers see only code changes, not GSD planning artifacts.

**Requirements:**
- REQ-PRBRANCH-01: System MUST identify commits that only modify `.planning/` files
- REQ-PRBRANCH-02: System MUST create a new branch with planning commits filtered out
- REQ-PRBRANCH-03: Code changes MUST be preserved exactly as committed
- REQ-PRBRANCH-04: System MUST NOT delete a `.planning/` path the target branch already tracks
- REQ-PRBRANCH-05: Verification MUST assert against the active filter mode's contract, not an unconditional zero

**Filter modes.** `planning.pr_strict` selects what "filtered" means. The default mode treats `.planning/` as two populations: structural state that belongs in review (`STATE.md`, `ROADMAP.md`, `MILESTONES.md`, `PROJECT.md`, `REQUIREMENTS.md`, `milestones/**`) and transient per-phase artifacts that do not (`phases/`, `quick/`, `research/`, `threads/`, `todos/`, `debug/`, `seeds/`, `codebase/`, `ui-reviews/`). Strict mode collapses that distinction: nothing under `.planning/` reaches the PR branch, and a commit is carried over only when it touches at least one file outside `.planning/`.

Strict mode exists because the two ways to keep planning private are not equivalent. Turning off `planning.commit_docs` keeps `.planning/` out of git, which also takes parallel executor worktrees with it — a worktree is checked out from a commit, so an untracked planning tree is simply absent inside it and the executor has no `PLAN.md` to read. Strict mode leaves planning committed, so worktrees and revert paths keep working, and moves the guarantee to the publication boundary instead. See [Publish PRs without planning artifacts](how-to/publish-prs-without-planning-artifacts.md).

Both modes filter by forcing the excluded paths back to whatever the target branch already tracks, in the index *and* the working tree. Un-staging alone would record a deletion of any planning file the target branch carries, and would leave the picked file untracked on disk, where it makes a later cherry-pick of the same path abort.

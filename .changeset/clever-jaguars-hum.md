---
type: Fixed
pr: 0
---
**/gsd-pr-branch now refuses to verify a PR branch that would delete planning files the target branch tracks** — the verification step counts planning-tree deletions via git diff --name-status and fails on any non-zero count, instead of reporting clean while pre-existing planning content was stripped. The underlying deletion class in the cherry-pick filter was already fixed by the strict-mode rewrite; this makes the workflow able to detect it. (#3679)

---
type: Fixed
pr: 4042
---
phase add and phase add-batch now count phase numbers held by sibling git worktrees before allocating max+1, instead of colliding with them (the reported incident minted a second Phase 441 while a worktree already held one with six written plans); add-batch also now counts roadmap bullet rows (#1229 finally reaches the batch path) (#3849)

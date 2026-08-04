---
type: Added
pr: 0
---
**Agent-dispatch isolation guard.** A missing isolation parameter on an executor Agent() dispatch is now hard-blocked when the project resolves to harness-worktree, closing the #260-class main-checkout write path the prose-only substitution instruction could silently skip. (#3045)

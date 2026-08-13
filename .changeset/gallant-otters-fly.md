---
type: Changed
pr: 3405
---
**`validate health` splits two previously-conflated warning codes into their own codes** — W021 now covers only the phase-id-convention mismatch it originally meant; the STATE-vs-ROADMAP milestone-complete mismatch it used to also report moves to the new W026. Likewise W017 now covers only orphan worktrees; the stale-worktree case moves to the new W027.

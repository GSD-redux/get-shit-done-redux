---
type: Fixed
pr: 0
---
gsd-health's STATE/ROADMAP staleness warning (W011) now reads the current phase from the YAML frontmatter format gsd-tools itself writes (current_phase), in addition to the legacy prose, canonical body, and pipe-table forms, and suppresses the warning when the recorded status reports completion in the state writer's own vocabulary (status: completed). The stale-worktree warning (W027) no longer advises unconditional forced removal: its remediation now directs checking for uncommitted work first (git -C <path> status --porcelain), removing non-destructively when clean, with --force presented as an explicit opt-in to discard changes.

**Part A — milestone-state write (skip when a workstream is active).** Skip Part A if `GSD_WS` is non-empty (parsed in Step 1). The active workstream's own `.planning/workstreams/<name>/STATE.md`/`ROADMAP.md`/`REQUIREMENTS.md` already carry this milestone's state. Writing a `## Current Milestone` heading here would clobber the shared file, and with parallel milestones across workstreams, whichever workstream runs `new-milestone` last would silently win the shared heading (#2308). In flat mode (`GSD_WS` empty), run Part A exactly as before:

Add/update:

```markdown
## Current Milestone: v[X.Y] [Name]

**Goal:** [One sentence describing milestone focus]

**Target features:**
- [Feature 1]
- [Feature 2]
- [Feature 3]
```

Update Active requirements section and "Last updated" footer.

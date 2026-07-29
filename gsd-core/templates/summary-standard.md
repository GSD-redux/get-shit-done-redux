---
phase: XX-name
plan: YY
subsystem: [primary category]
tags: [searchable tech]
provides:
  - [bullet list of what was built/delivered]
affects: [list of phase names or keywords]
actuals:
  tokens: [chars/4 over files actually changed]
  tasks: [tasks completed]
  commits: [commits made]
tech-stack:
  added: [libraries/tools]
  patterns: [architectural/code patterns]
key-files:
  created: [important files created]
  modified: [important files modified]
key-decisions:
  - "Decision 1"
# coverage: (#1602) optional per-deliverable UAT-routing block — see templates/summary.md <coverage_guidance>.
#   Add live `coverage:` entries (id/description/verification[]/human_judgment[/rationale]) to enable
#   deterministic UAT routing in verify-work; OMIT for legacy prose-only SUMMARYs. When coverage is
#   uncertain, default human_judgment: true with a rationale — never auto-skip the human.
duration: Xmin
completed: YYYY-MM-DD
status: complete
---

# Phase [X]: [Name] Summary

**[Substantive one-liner describing outcome]**

## Performance
- **Duration:** [time]
- **Tasks:** [count completed]
- **Files modified:** [count]

## Accomplishments
- [Key outcome 1]
- [Key outcome 2]

## Task Commits
1. **Task 1: [task name]** - `hash`
2. **Task 2: [task name]** - `hash`
3. **Task 3: [task name]** - `hash`

## Files Created/Modified
- `path/to/file.ts` - What it does
- `path/to/another.ts` - What it does

## Decisions & Deviations
[Key decisions or "None - followed plan as specified"]
[Minor deviations if any, or "None"]

## Next Phase Readiness
[What's ready for next phase]

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
key-decisions: []
# coverage: (#1602) optional per-deliverable UAT-routing block — see templates/summary.md <coverage_guidance>.
#   Add live `coverage:` entries to enable deterministic UAT routing in verify-work; OMIT for legacy
#   prose-only SUMMARYs. When coverage is uncertain, default human_judgment: true — never auto-skip the human.
duration: Xmin
completed: YYYY-MM-DD
status: complete
---

**Status (#2830):** `status: complete` is the default — the plan finished. Use `status: halted` instead when the plan reached a designed stop (a gate failure, a spike concluding without expanding into the full build, or any other intentional non-completion) and intentionally left tasks unfinished.

# Phase [X]: [Name] Summary (Minimal)

**[Substantive one-liner describing outcome]**

## Performance
- **Duration:** [time]
- **Tasks:** [count]
- **Files modified:** [count]

## Accomplishments
- [Most important outcome]
- [Second key accomplishment]

## Task Commits
1. **Task 1: [task name]** - `hash`
2. **Task 2: [task name]** - `hash`

## Files Created/Modified
- `path/to/file.ts` - What it does

## Next Phase Readiness
[Ready for next phase]

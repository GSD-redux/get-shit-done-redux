---
phase: XX-name
plan: YY
subsystem: [primary category]
tags: [searchable tech]
requires:
  - phase: [prior phase]
    provides: [what that phase built]
provides:
  - [bullet list of what was built/delivered]
affects: [list of phase names or keywords]
tech-stack:
  added: [libraries/tools]
  patterns: [architectural/code patterns]
key-files:
  created: [important files created]
  modified: [important files modified]
key-decisions:
  - "Decision 1"
patterns-established:
  - "Pattern 1: description"
# coverage: (#1602) optional per-deliverable UAT-routing block — see templates/summary.md <coverage_guidance>.
#   Add live `coverage:` entries (id/description/verification[]/human_judgment[/rationale]) to enable
#   deterministic UAT routing in verify-work; OMIT for legacy prose-only SUMMARYs. When coverage is
#   uncertain, default human_judgment: true with a rationale — never auto-skip the human.
duration: Xmin
completed: YYYY-MM-DD
status: complete
---

**Status (#2830):** `status: complete` is the default — the plan finished. Use `status: halted` instead when the plan reached a designed stop (a gate failure, a spike concluding without expanding into the full build, or any other intentional non-completion) and intentionally left tasks unfinished.

# Phase [X]: [Name] Summary (Complex)

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

## Decisions Made
[Key decisions with brief rationale]

## Deviations from Plan (Auto-fixed)
[Detailed auto-fix records per GSD deviation rules]

## Issues Encountered
[Problems during planned work and resolutions]

## Next Phase Readiness
[What's ready for next phase]
[Blockers or concerns]

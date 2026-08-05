---
name: gsd:stats
description: Display project statistics — phases, plans, requirements, git metrics, and timeline
effort: low
allowed-tools:
  - Read
  - Bash
  - Grep
requires: [phase, progress]
---
<objective>
Display comprehensive project statistics including phase progress, plan execution metrics, requirements completion, git history stats, and project timeline.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/stats.md
</execution_context>

<process>
Execute end-to-end.
</process>

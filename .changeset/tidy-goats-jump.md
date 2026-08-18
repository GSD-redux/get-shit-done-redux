---
type: Added
pr: 3592
---
**Quick tasks can now be archived at milestone close-out.** `/gsd-complete-milestone` offers an opt-in prompt to sweep `.planning/quick/` into `.planning/milestones/<version>-quick/` with a generated `README.md` index and a reset `Quick Tasks Completed` table, and `/gsd-cleanup` offers the same archival retroactively for milestones that were already closed. (#2142)

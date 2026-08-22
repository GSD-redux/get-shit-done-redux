---
type: Fixed
pr: 3758
---
**Advisory plan-checker findings no longer force a replan** — Dimension 3b (undeclared same-wave coupling, #1954) is retagged to the advisory `info` tier, plan-phase accepts INFO-only checker results instead of entering the revision loop, and planners can declare deliberate coupling with a new optional `coupling_justified` plan-frontmatter field that the checker recognizes — so multi-wave phases stop paying a guaranteed extra planner pass and intentionally coupled plans converge instead of stalling.

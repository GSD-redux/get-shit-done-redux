---
type: Fixed
pr: 4008
---
**`gsd-roadmapper` no longer contradicts itself on write-vs-approve ordering** — the agent's role, output format, and completion checklist now match its write-first execution flow (write for durability, return `## ROADMAP CREATED` with a preview; the orchestrator presents and owns the approval gate), and the orphaned `## ROADMAP DRAFT` template that matched no orchestrator branch is gone. (#3797)

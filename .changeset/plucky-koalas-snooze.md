---
type: Fixed
pr: 0
---
**Capability hooks can no longer be silently registered-but-never-run** — the capability validator now checks that each host call site's dispatch text covers every hook KIND registered at that point (a gate-only consumer fails validation when a step or contribution hook is registered there), and the plan/execute/verify host consumers now dispatch steps and contributions generically per the loop hook contract instead of hand-rolling one kind. (#3606)

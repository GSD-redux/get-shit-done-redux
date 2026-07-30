---
type: Fixed
pr: 2881
---
**The plan-phase decision-coverage gate can no longer silently pass when its context-path argument is missing** — the handler now fails closed on an empty/missing argument (a caller error), and the plan-phase workflow recomputes the CONTEXT.md path in the same Bash block that runs the gate (the variable set in the init block did not survive into the gate block). A genuinely-absent CONTEXT.md still produces the legitimate green skip. Previously the gate reported `passed` without ever checking coverage. (#2770)

---
type: Fixed
pr: 3599
---
**`roadmap` tools recognize table-style phase listings** — a ROADMAP whose current-milestone phases are declared as markdown table rows (`| 20 | … |`) reported phase_count: 0 and found: false across roadmap.analyze, roadmap.get-phase, init.phase-op, and the milestone filter; all four surfaces now resolve table-declared phases (progress tables and fenced examples excluded). (#3577)

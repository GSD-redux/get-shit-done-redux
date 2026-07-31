---
type: Fixed
pr: 2953
---
**phase.complete no longer closes a phase while its plans are silently unexecuted** — a phase could previously close "complete" with an arbitrary number of plans missing a completion record (a confirmed incident closed a phase with 6/30 plans unexecuted, including its entire final scope). phase.complete now refuses, naming the unexecuted plans, unless they are explicitly retired via `status: superseded` frontmatter. (#2648)

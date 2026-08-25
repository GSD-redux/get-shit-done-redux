---
id: 24
title: Session Reporting
group: Context Engineering Features
---

**Command:** `/gsd-pause-work --report`

**Purpose:** Generate a structured post-session summary document capturing work performed, outcomes achieved, and estimated resource usage.

**Requirements:**
- REQ-REPORT-01: System MUST gather data from STATE.md, git log, and plan/summary files
- REQ-REPORT-02: System MUST include commits made, plans executed, and phases progressed
- REQ-REPORT-03: System MUST estimate token usage and cost based on session activity
- REQ-REPORT-04: System MUST include active blockers and decisions made
- REQ-REPORT-05: System MUST recommend next steps

**Produces:** `.planning/reports/SESSION_REPORT.md`

**Report Sections:**
- Session overview (duration, milestone, phase)
- Work performed (commits, plans, phases)
- Outcomes and deliverables
- Blockers and decisions
- Resource estimates (tokens, cost)
- Next steps recommendation

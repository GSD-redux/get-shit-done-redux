---
id: 14
title: Auto-Advance (Next)
group: Planning Features
---

**Command:** `/gsd-progress --next`

**Purpose:** Automatically detect current project state and advance to the next logical workflow step, eliminating the need to remember which phase/step you're on.

**Requirements:**
- REQ-NEXT-01: System MUST read STATE.md, ROADMAP.md, and phase directories to determine current position
- REQ-NEXT-02: System MUST detect whether discuss, plan, execute, or verify is needed
- REQ-NEXT-03: System MUST invoke the correct command automatically
- REQ-NEXT-04: System MUST suggest `/gsd-new-project` if no project exists
- REQ-NEXT-05: System MUST suggest `/gsd-complete-milestone` when all phases are complete

**State Detection Logic:**
| State | Action |
|-------|--------|
| No `.planning/` directory | Suggest `/gsd-new-project` |
| Phase has no CONTEXT.md | Run `/gsd-discuss-phase` |
| Phase has no PLAN.md files | Run `/gsd-plan-phase` |
| Phase has plans but no SUMMARY.md | Run `/gsd-execute-phase` |
| Phase executed but no VERIFICATION.md | Run `/gsd-verify-work` |
| All phases complete | Suggest `/gsd-complete-milestone` |

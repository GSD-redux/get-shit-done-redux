---
id: 23
title: Session Management
group: Context Engineering Features
---

**Commands:** `/gsd-pause-work`, `/gsd-resume-work`, `/gsd-progress`

**Purpose:** Maintain project continuity across context resets and sessions.

**Requirements:**
- REQ-SESSION-01: Pause MUST save current position and next steps to `continue-here.md` and structured `HANDOFF.json`
- REQ-SESSION-02: Resume MUST restore full project context from HANDOFF.json (preferred) or state files (fallback)
- REQ-SESSION-03: Progress MUST show current position, next action, and overall completion
- REQ-SESSION-04: Progress MUST read all state files (STATE.md, ROADMAP.md, phase directories)
- REQ-SESSION-05: All session operations MUST work after `/clear` (context reset)
- REQ-SESSION-06: HANDOFF.json MUST include blockers, human actions pending, and in-progress task state
- REQ-SESSION-07: Resume MUST surface human actions and blockers immediately on session start

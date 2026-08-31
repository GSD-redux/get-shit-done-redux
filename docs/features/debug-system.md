---
id: 28
title: Debug System
group: Utility Features
---

**Command:** `/gsd-debug [description]`

**Purpose:** Systematic debugging with persistent state across context resets.

**Requirements:**
- REQ-DEBUG-01: System MUST create debug session file in `.planning/debug/`
- REQ-DEBUG-02: System MUST track hypotheses, evidence, and eliminated theories
- REQ-DEBUG-03: System MUST persist state so debugging survives context resets
- REQ-DEBUG-04: System MUST require human verification before marking resolved
- REQ-DEBUG-05: Resolved sessions MUST append to `.planning/debug/knowledge-base.md`
- REQ-DEBUG-06: Knowledge base MUST be consulted on new debug sessions to prevent re-investigation

**Debug Session States:** `gathering` → `investigating` → `fixing` → `verifying` → `awaiting_human_verify` → `resolved`

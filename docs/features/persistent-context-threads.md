---
id: 44
title: Persistent Context Threads
group: v1.27 Features
---

**Command:** `/gsd-thread [name | description]`

**Purpose:** Lightweight cross-session knowledge stores for work that spans multiple sessions but doesn't belong to any specific phase. Lighter weight than `/gsd-pause-work` — no phase state, no plan context.

**Requirements:**
- REQ-THREAD-01: System MUST support create, list, and resume modes
- REQ-THREAD-02: Threads MUST be stored in `.planning/threads/` as markdown files
- REQ-THREAD-03: Thread files MUST include Goal, Context, References, and Next Steps sections
- REQ-THREAD-04: Resuming a thread MUST load its full context into the current session
- REQ-THREAD-05: Threads MUST be promotable to phases or backlog items

**Produces:** `.planning/threads/{slug}.md` — Persistent context thread

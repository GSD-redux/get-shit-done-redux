---
id: 101
title: Hard Stop Safety Gates in /gsd-progress --next
group: v1.34.0 Features
---

**Command:** `/gsd-progress --next`

**Purpose:** Prevent `/gsd-progress --next` from entering runaway loops by adding hard stop safety gates and a consecutive-call guard that interrupts autonomous chaining when repeated identical steps are detected.

**Requirements:**
- REQ-NEXT-GATE-01: `/gsd-progress --next` MUST track consecutive same-step calls
- REQ-NEXT-GATE-02: On repeated same-step, system MUST present a hard stop gate to the user
- REQ-NEXT-GATE-03: User MUST explicitly confirm to continue past a hard stop gate

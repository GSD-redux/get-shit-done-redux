---
id: 52
title: Manager Dashboard
group: v1.28 Features
---

**Command:** `/gsd-manager`

**Purpose:** Interactive command center for managing multiple phases from one terminal.

**Requirements:**
- REQ-MGR-01: System MUST show overview of all phases with status
- REQ-MGR-02: System MUST filter to current milestone scope
- REQ-MGR-03: System MUST show phase dependencies and conflicts

**Produces:** Interactive terminal output

**Process:**
1. **Scan** — Load all phases in the current milestone with their statuses
2. **Display** — Render overview showing phase dependencies, conflicts, and progress
3. **Interact** — Accept commands to navigate, inspect, or act on individual phases

---
id: 12
title: Freeform Routing
group: Planning Features
---

**Command:** `/gsd-progress --do` (see also `/gsd-manager` for interactive routing)

**Purpose:** Analyze freeform text and route to the appropriate GSD command.

**Requirements:**
- REQ-DO-01: System MUST parse user intent from natural language input
- REQ-DO-02: System MUST map intent to the best matching GSD command
- REQ-DO-03: System MUST confirm the routing with the user before executing
- REQ-DO-04: System MUST handle project-exists vs no-project contexts differently
- REQ-DO-05: Routing rules MUST order specific operations before the generic keyword rules they shadow (specific-before-generic)
- REQ-DO-06: Dispatch MUST forward only arguments the selected command accepts; the freeform sentence is forwarded only when that command explicitly accepts a freeform task description

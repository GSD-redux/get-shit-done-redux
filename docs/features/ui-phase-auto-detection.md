---
id: 54
title: UI Phase Auto-Detection
group: v1.28 Features
---

**Part of:** `/gsd-new-project` and `/gsd-progress`

**Purpose:** Automatically detect UI-heavy projects and surface `/gsd-ui-phase` recommendation.

**Requirements:**
- REQ-UI-DETECT-01: System MUST detect UI signals in project description (keywords, framework references)
- REQ-UI-DETECT-02: System MUST annotate ROADMAP.md phases with `ui_hint` when applicable
- REQ-UI-DETECT-03: System MUST suggest `/gsd-ui-phase` in next steps for UI-heavy phases
- REQ-UI-DETECT-04: System MUST NOT make `/gsd-ui-phase` mandatory

**Process:**
1. **Detect** — Scan project description and tech stack for UI signals (keywords, framework references)
2. **Annotate** — Add `ui_hint` markers to applicable phases in ROADMAP.md
3. **Surface** — Include `/gsd-ui-phase` recommendation in next steps for UI-heavy phases

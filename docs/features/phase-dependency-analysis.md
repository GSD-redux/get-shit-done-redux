---
id: 77
title: Phase Dependency Analysis
group: v1.32 Features
---

**Command:** `/gsd-manager --analyze-deps`

**Purpose:** Detect phase dependencies and suggest `Depends on` entries for ROADMAP.md before running `/gsd-manager`.

**Requirements:**
- REQ-DEP-01: System MUST detect file overlap between phases
- REQ-DEP-02: System MUST detect semantic dependencies (API/schema producers and consumers)
- REQ-DEP-03: System MUST detect data flow dependencies (output producers and readers)
- REQ-DEP-04: System MUST suggest dependency entries with user confirmation before writing

**Produces:** Dependency suggestion table; optionally updates ROADMAP.md `Depends on` fields

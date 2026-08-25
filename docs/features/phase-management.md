---
id: 9
title: Phase Management
group: Planning Features
---

**Commands:** `/gsd-phase`, `/gsd-phase --insert [N]`, `/gsd-phase --remove [N]`

**Purpose:** Dynamic roadmap modification during development.

**Requirements:**
- REQ-PHASE-01: Add MUST append a new phase to the end of the current roadmap
- REQ-PHASE-02: Insert MUST use decimal numbering (e.g., 3.1) between existing phases
- REQ-PHASE-03: Remove MUST renumber all subsequent phases
- REQ-PHASE-04: Remove MUST prevent removing phases that have been executed
- REQ-PHASE-05: All operations MUST update ROADMAP.md and create/remove phase directories
- REQ-PHASE-06: Bare-number phase lookup MUST resolve digit-leading slug names consistently across phase verbs, preserve project-code-prefixed result shaping, and fail loudly when multiple directories match

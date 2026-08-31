---
id: 96
title: Plan Import
group: v1.34.0 Features
---

**Command:** `/gsd-import --from <filepath>`

**Purpose:** Ingest an external plan file into the GSD planning system with conflict detection against `PROJECT.md` decisions, converting it to a valid GSD PLAN.md and validating it through the plan-checker.

**Requirements:**
- REQ-IMPORT-01: Importer MUST detect conflicts between the external plan and existing PROJECT.md decisions
- REQ-IMPORT-02: All detected conflicts MUST be presented to the user for resolution before writing
- REQ-IMPORT-03: Imported plan MUST be written as a valid GSD PLAN.md format
- REQ-IMPORT-04: Written plan MUST pass `gsd-plan-checker` validation

---
id: 19
title: Health Validation
group: Quality Assurance Features
---

**Command:** `/gsd-health [--repair] [--backfill]`

**Purpose:** Validate `.planning/` directory integrity and auto-repair issues.

**Requirements:**
- REQ-HEALTH-01: System MUST check for missing required files
- REQ-HEALTH-02: System MUST validate configuration consistency
- REQ-HEALTH-03: System MUST detect orphaned plans without summaries
- REQ-HEALTH-04: System MUST check phase numbering and roadmap sync
- REQ-HEALTH-05: `--repair` flag MUST auto-fix recoverable issues except DESTRUCTIVE-risk ones, which it MUST report but never auto-apply
- REQ-HEALTH-06: `--backfill` flag MUST synthesize missing MILESTONES.md entries from archived milestone snapshots

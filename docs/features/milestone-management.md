---
id: 8
title: Milestone Management
group: Core Features
---

**Commands:** `/gsd-audit-milestone`, `/gsd-complete-milestone`, `/gsd-new-milestone [name]`

**Purpose:** Verify milestone completion, archive, tag release, and start the next development cycle.

**Requirements:**
- REQ-MILE-01: Audit MUST verify all milestone requirements are met
- REQ-MILE-02: Audit MUST detect stubs, placeholder implementations, and untested code
- REQ-MILE-03: Audit MUST check Nyquist validation compliance across phases
- REQ-MILE-04: Complete MUST archive milestone data to MILESTONES.md
- REQ-MILE-05: Complete MUST offer git tag creation for the release
- REQ-MILE-06: Complete MUST offer squash merge or merge with history for branching strategies
- REQ-MILE-07: Complete MUST clean up UI review screenshots
- REQ-MILE-08: New milestone MUST follow same flow as new-project (questions → research → requirements → roadmap)
- REQ-MILE-09: New milestone MUST NOT reset existing workflow configuration

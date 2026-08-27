---
id: 43
title: Backlog Parking Lot
group: v1.27 Features
---

**Commands:** `/gsd-capture --backlog <description>`, `/gsd-review-backlog`, `/gsd-capture --seed <idea>`, `/gsd-capture --list-seeds [status]`

**Purpose:** Capture ideas that aren't ready for active planning. Backlog items use 999.x numbering to stay outside the active phase sequence. Seeds are forward-looking ideas with trigger conditions that surface automatically at the right milestone. `--list-seeds` provides a read-only audit of all parked seeds (with optional status filter) without waiting for the next milestone.

**Requirements:**
- REQ-BACKLOG-01: Backlog items MUST use 999.x numbering to stay outside active phase sequence
- REQ-BACKLOG-02: Phase directories MUST be created immediately so `/gsd-discuss-phase` and `/gsd-plan-phase` work on them
- REQ-BACKLOG-03: `/gsd-review-backlog` MUST support promote, keep, and remove actions per item
- REQ-BACKLOG-04: Promoted items MUST be renumbered into the active milestone sequence
- REQ-SEED-01: Seeds MUST capture the full WHY and WHEN to surface conditions
- REQ-SEED-02: `/gsd-new-milestone` MUST scan seeds and present matches
- REQ-SEED-03: `/gsd-capture --list-seeds` MUST list seeds with status, scope, and trigger for audit, with optional status filtering

**Produces:**
| Artifact | Description |
|----------|-------------|
| `.planning/phases/999.x-slug/` | Backlog item directory |
| `.planning/seeds/SEED-NNN-slug.md` | Seed with trigger conditions |

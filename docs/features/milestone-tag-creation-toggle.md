---
id: 141
title: Milestone Tag Creation Toggle
group: v1.42.1 Features
---

**Command:** `/gsd-complete-milestone`

**Config key:** `git.create_tag`

**Purpose:** Let projects with external release automation complete milestones without creating local git tags.

**Behavior:** `git.create_tag: false` skips milestone tag creation. The workflow still updates milestone artifacts and state.

**Requirements:**
- REQ-MILESTONE-TAG-01: Missing config MUST preserve automatic tag creation.
- REQ-MILESTONE-TAG-02: Existing tag collisions MUST fail clearly instead of overwriting tags.
- REQ-MILESTONE-TAG-03: Disabling tag creation MUST NOT skip milestone archival.

**Reference:** [Configuration Reference](CONFIGURATION.md#git-branching)

---
id: 129
title: Issue-Driven Orchestration Guide
group: v1.41.0 Features
---

**Purpose:** Document a recipe for driving the full GSD workflow from a GitHub / Linear / Jira issue, mapping tracker-centric concepts onto existing GSD primitives.

**Document:** [`docs/issue-driven-orchestration.md`](issue-driven-orchestration.md)

**Covered workflow:**
1. Create an isolated workspace per issue (`/gsd-workspace --new`)
2. Run the manager dashboard to get oriented (`/gsd-manager`)
3. Execute autonomously (`/gsd-autonomous`)
4. Verify and review (`/gsd-verify-work`, `/gsd-review`)
5. Ship and close the issue (`/gsd-ship`)

No new commands or daemon process — purely a documentation artifact that maps existing primitives onto a tracker-driven workflow.

**Reference issue:** [#2840](https://github.com/open-gsd/gsd-core/pull/2840)

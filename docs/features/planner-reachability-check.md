---
id: 80
title: Planner Reachability Check
group: v1.32 Features
---

**Part of:** `/gsd-plan-phase`

**Purpose:** Validate that plan steps are achievable before committing to execution.

**Requirements:**
- REQ-REACH-01: Planner MUST validate that each plan step references reachable files and APIs
- REQ-REACH-02: Unreachable steps MUST be flagged during planning, not discovered during execution

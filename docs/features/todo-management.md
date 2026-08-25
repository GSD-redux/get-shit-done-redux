---
id: 29
title: Todo Management
group: Utility Features
---

**Commands:** `/gsd-capture [desc]`, `/gsd-capture --list`

**Purpose:** Capture ideas and tasks during sessions for later work.

**Requirements:**
- REQ-TODO-01: System MUST capture todo from current conversation context
- REQ-TODO-02: Todos MUST be stored in `.planning/todos/pending/`
- REQ-TODO-03: Completed todos MUST move to `.planning/todos/completed/`
- REQ-TODO-04: Check-todos MUST list all pending items with selection to work on one

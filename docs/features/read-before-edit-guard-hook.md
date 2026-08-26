---
id: 73
title: Read-Before-Edit Guard Hook
group: v1.32 Features
---

**Part of:** Hooks (`PreToolUse`)

**Purpose:** Prevent infinite retry loops in non-Claude runtimes by ensuring files are read before editing.

**Requirements:**
- REQ-RBE-01: Hook MUST detect Edit/Write tool calls that target files not previously read in the session
- REQ-RBE-02: Hook MUST advise reading the file first (advisory, non-blocking)
- REQ-RBE-03: Hook MUST prevent infinite retry loops common in runtimes without built-in read-before-edit enforcement

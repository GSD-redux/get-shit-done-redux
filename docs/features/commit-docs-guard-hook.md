---
id: 87
title: Commit-Docs Guard Hook
group: v1.32 Features
---

**Hook:** `gsd-commit-docs.js`

**Purpose:** PreToolUse hook that enforces the `commit_docs` configuration, preventing `.planning/` files from being committed when `planning.commit_docs` is `false`.

**Requirements:**
- REQ-COMMITDOCS-01: Hook MUST intercept git commit commands that stage `.planning/` files
- REQ-COMMITDOCS-02: Hook MUST block commits containing `.planning/` files when `commit_docs` is `false`
- REQ-COMMITDOCS-03: Hook MUST be advisory — does not block when `commit_docs` is `true` or absent

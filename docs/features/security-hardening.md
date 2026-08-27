---
id: 46
title: Security Hardening
group: v1.27 Features
---

**Purpose:** Defense-in-depth security for GSD's planning artifacts. Because GSD generates markdown files that become LLM system prompts, user-controlled text flowing into these files is a potential indirect prompt injection vector.

**Components:**

**1. Centralized Security Module** (`security.cjs`)
- Path traversal prevention — validates file paths resolve within the project directory
- Prompt injection detection — scans for known injection patterns in user-supplied text
- Safe JSON parsing — catches malformed input before state corruption
- Field name validation — prevents injection through config field names
- Shell argument validation — sanitizes user text before shell interpolation

**2. Prompt Injection Guard Hook** (`gsd-prompt-guard.js`)
PreToolUse hook that scans Write/Edit calls targeting `.planning/` for injection patterns. Advisory-only — logs detection for awareness without blocking legitimate operations.

**3. Workflow Guard Hook** (`gsd-workflow-guard.js`)
PreToolUse hook that detects when Claude attempts file edits outside a GSD workflow context. Advises using `/gsd-quick` or `/gsd-fast` instead of direct edits. Configurable via `hooks.workflow_guard` (default: false).

**4. CI-Ready Injection Scanner** (`prompt-injection-scan.security.test.cjs`)
Test suite that scans all agent, workflow, and command files for embedded injection vectors.

**Requirements:**
- REQ-SEC-01: All user-supplied file paths MUST be validated against the project directory
- REQ-SEC-02: Prompt injection patterns MUST be detected before text enters planning artifacts
- REQ-SEC-03: Security hooks MUST be advisory-only (never block legitimate operations)
- REQ-SEC-04: JSON parsing of user input MUST catch malformed data gracefully
- REQ-SEC-05: macOS `/var` → `/private/var` symlink resolution MUST be handled in path validation

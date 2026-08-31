---
id: 56
title: Windsurf Runtime Support
group: v1.29 Features
---

**Part of:** `npx @opengsd/gsd-core`

**Purpose:** Add Windsurf as a supported AI CLI runtime for GSD installation and execution.

**Requirements:**
- REQ-WINDSURF-01: Installer MUST detect Windsurf runtime and offer it as a target
- REQ-WINDSURF-02: GSD commands MUST function correctly within Windsurf sessions

**Process:**
1. **Detect** — Identify Windsurf runtime availability on the system
2. **Install** — Configure GSD skills and hooks for the Windsurf environment

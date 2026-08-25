---
id: 55
title: Multi-Runtime Installer Selection
group: v1.28 Features
---

**Part of:** `npx @opengsd/gsd-core`

**Purpose:** Select multiple runtimes in a single interactive install session.

**Requirements:**
- REQ-MULTI-RT-01: Interactive prompt MUST support multi-select (e.g., Claude Code + Antigravity)
- REQ-MULTI-RT-02: CLI flags MUST continue to work for non-interactive installs

**Process:**
1. **Detect** — Identify available AI CLI runtimes on the system
2. **Prompt** — Present multi-select interface for runtime selection
3. **Install** — Configure GSD for all selected runtimes in a single session

---
id: 97
title: Rapid Codebase Scan
group: v1.34.0 Features
---

**Command:** `/gsd-map-codebase --fast [--focus tech|arch|quality|concerns]`

**Purpose:** Lightweight alternative to `/gsd-map-codebase` that spawns a single mapper agent for one or two combined focus areas, producing targeted output in `.planning/codebase/` without the overhead of 4 parallel agents.

**Requirements:**
- REQ-SCAN-01: Scan MUST spawn exactly one mapper agent (not four parallel agents)
- REQ-SCAN-02: Focus area MUST be one of: `tech`, `arch`, `quality`, `concerns`, or the combined `tech+arch` shorthand (default: `tech+arch`); combined focus runs as a single agent covering both areas in one pass
- REQ-SCAN-03: Output MUST be written to `.planning/codebase/` in the same format as `/gsd-map-codebase`

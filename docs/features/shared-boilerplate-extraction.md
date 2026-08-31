---
id: 120
title: Shared Boilerplate Extraction
group: v1.37.0 Features
---

**Purpose:** Reduce duplication across agents by extracting two common boilerplate blocks into shared reference files loaded on demand. Keeps agent files within size budget and makes boilerplate updates a single-file change.

**Requirements:**
- REQ-BOILER-01: Mandatory-initial-read instructions extracted to `references/mandatory-initial-read.md`
- REQ-BOILER-02: Project-skills-discovery instructions extracted to `references/project-skills-discovery.md`
- REQ-BOILER-03: Agents that previously inlined these blocks MUST now reference them via `@` required_reading

**Reference files:** `references/mandatory-initial-read.md`, `references/project-skills-discovery.md`

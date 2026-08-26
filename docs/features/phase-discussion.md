---
id: 2
title: Phase Discussion
group: Core Features
---

**Command:** `/gsd-discuss-phase [N] [--auto] [--batch]`

**Purpose:** Capture user's implementation preferences and decisions before research and planning begin. Eliminates the gray areas that cause AI to guess.

**Requirements:**
- REQ-DISC-01: System MUST analyze the phase scope and identify decision areas (gray areas)
- REQ-DISC-02: System MUST categorize gray areas by type (visual, API, content, organization, etc.)
- REQ-DISC-03: System MUST ask only questions not already answered in prior CONTEXT.md files
- REQ-DISC-04: System MUST persist decisions in `{phase}-CONTEXT.md` with canonical references
- REQ-DISC-05: System MUST support `--auto` flag to auto-select recommended defaults
- REQ-DISC-06: System MUST support `--batch` flag for grouped question intake
- REQ-DISC-07: System MUST scout relevant source files before identifying gray areas (code-aware discussion)
- REQ-DISC-08: System MUST adapt gray area language to product-outcome terms when USER-PROFILE.md indicates a non-technical owner (learning_style: guided, jargon in frustration_triggers, or high-level explanation depth)
- REQ-DISC-09: When REQ-DISC-08 applies, advisor_research rationale paragraphs MUST be rewritten in plain language — same decisions, translated framing

**Produces:** `{padded_phase}-CONTEXT.md` — User preferences that feed into research and planning

**Gray Area Categories:**
| Category | Example Decisions |
|----------|-------------------|
| Visual features | Layout, density, interactions, empty states |
| APIs/CLIs | Response format, flags, error handling, verbosity |
| Content systems | Structure, tone, depth, flow |
| Organization | Grouping criteria, naming, duplicates, exceptions |

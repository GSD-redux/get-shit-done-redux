---
id: 135
title: Custom Ship PR Body Sections
group: v1.42.1 Features
---

**Command:** `/gsd-ship`

**Config key:** `ship.pr_body_sections`

**Purpose:** Add project-specific PRD-style sections to generated PR bodies without editing GSD workflow files.

**Behavior:** Configured sections append after the required `Summary`, `Changes`, `Requirements Addressed`, `Verification`, and `Key Decisions` sections. They can copy from artifact headings, render templates, or fall back to static text.

**Requirements:**
- REQ-SHIP-SECTIONS-01: Custom sections MUST NOT replace, remove, or reorder required PR sections.
- REQ-SHIP-SECTIONS-02: Unknown template tokens MUST be rejected by config validation.
- REQ-SHIP-SECTIONS-03: Disabled sections MUST stay in config without appearing in PR output.

**Reference:** [Custom PR Body Sections](ship-pr-body-sections.md)

---
id: 65
title: Claim Provenance Tagging
group: v1.31 Features
---

**Part of:** `/gsd-plan-phase --research-phase <N>`

**Purpose:** Ensure research claims are tagged with source evidence and assumptions are logged separately.

**Requirements:**
- REQ-PROVENANCE-01: Researcher MUST mark claims with source evidence references
- REQ-PROVENANCE-02: Assumptions MUST be logged separately from sourced claims
- REQ-PROVENANCE-03: System MUST distinguish between evidenced facts and inferred assumptions

**Process:**
1. **Research** — Researcher gathers information from codebase and domain sources
2. **Tag** — Each claim is annotated with its source (file path, documentation, API response)
3. **Separate** — Assumptions without direct evidence are logged in a distinct section

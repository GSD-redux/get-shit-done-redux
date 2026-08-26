---
id: 61
title: Documentation Generation
group: v1.31 Features
---

**Command:** `/gsd-docs-update`

**Purpose:** Generate and verify project documentation with accuracy checks.

**Requirements:**
- REQ-DOCS-01: System MUST spawn `gsd-doc-writer` agent to generate documentation
- REQ-DOCS-02: System MUST spawn `gsd-doc-verifier` agent to check accuracy
- REQ-DOCS-03: System MUST verify generated documentation against actual implementation

**Produces:**
| Artifact | Description |
|----------|-------------|
| Updated project documentation | Generated and verified documentation files |

**Process:**
1. **Generate** — Spawn `gsd-doc-writer` to create or update documentation from implementation
2. **Verify** — Spawn `gsd-doc-verifier` to check documentation accuracy against codebase
3. **Output** — Produce verified documentation with accuracy annotations

---
id: 27
title: Codebase Mapping
group: Brownfield Features
---

**Command:** `/gsd-map-codebase [area]`

**Purpose:** Analyze an existing codebase before starting a new project or as the mapping handoff from `/gsd-onboard`, so GSD understands what exists.

**Requirements:**
- REQ-MAP-01: System MUST spawn parallel mapper agents for each analysis area
- REQ-MAP-02: System MUST produce structured documents in `.planning/codebase/`
- REQ-MAP-03: System MUST detect: tech stack, architecture patterns, coding conventions, concerns
- REQ-MAP-04: Subsequent `/gsd-new-project` MUST load codebase mapping and focus questions on what's being added
- REQ-MAP-05: Optional `[area]` argument MUST scope mapping to a specific area

**Produces:**
| Document | Content |
|----------|---------|
| `STACK.md` | Languages, frameworks, databases, infrastructure |
| `ARCHITECTURE.md` | Patterns, layers, data flow, boundaries |
| `CONVENTIONS.md` | Naming, file organization, code style, testing patterns |
| `CONCERNS.md` | Technical debt, security issues, performance bottlenecks |
| `STRUCTURE.md` | Directory layout and file organization |
| `TESTING.md` | Test infrastructure, coverage, patterns |
| `INTEGRATIONS.md` | External services, APIs, third-party dependencies |

**Incremental remap — `--paths` (#2003):** The mapper accepts an optional
`--paths <p1,p2,...>` scope hint. When provided, it restricts exploration
to the listed repo-relative prefixes instead of scanning the whole tree.
This is the pathway used by the post-execute codebase-drift gate to refresh
only the subtrees the phase actually changed. Each produced document carries
`last_mapped_commit` in its YAML frontmatter so drift can be measured
against the mapping point, not HEAD.

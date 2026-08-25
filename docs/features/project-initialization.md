---
id: 1
title: Project Initialization
group: Core Features
---

**Command:** `/gsd-new-project [--auto @file.md]`

**Purpose:** Transform a user's idea into a fully structured project with research, scoped requirements, and a phased roadmap.

**Requirements:**
- REQ-INIT-01: System MUST conduct adaptive questioning until project scope is fully understood
- REQ-INIT-02: System MUST spawn parallel research agents to investigate the domain ecosystem
- REQ-INIT-03: System MUST extract requirements into v1 (must-have), v2 (future), and out-of-scope categories
- REQ-INIT-04: System MUST generate a phased roadmap with requirement traceability
- REQ-INIT-05: System MUST require user approval of the roadmap before proceeding
- REQ-INIT-06: System MUST prevent re-initialization when `.planning/PROJECT.md` already exists
- REQ-INIT-07: System MUST support `--auto @file.md` flag to skip interactive questions and extract from a document

**Produces:**
| Artifact | Description |
|----------|-------------|
| `PROJECT.md` | Project vision, constraints, technical decisions, evolution rules |
| `REQUIREMENTS.md` | Scoped requirements with unique IDs (REQ-XX) |
| `ROADMAP.md` | Phase breakdown with status tracking and requirement mapping |
| `STATE.md` | Initial project state with position, decisions, metrics |
| `config.json` | Workflow configuration |
| `research/SUMMARY.md` | Synthesized domain research |
| `research/STACK.md` | Technology stack investigation |
| `research/FEATURES.md` | Feature implementation patterns |
| `research/ARCHITECTURE.md` | Architecture patterns and trade-offs |
| `research/PITFALLS.md` | Common failure modes and mitigations |

**Process:**
1. **Questions** — Adaptive questioning guided by the "dream extraction" philosophy (not requirements gathering)
2. **Research** — 4 parallel researcher agents investigate stack, features, architecture, and pitfalls
3. **Synthesis** — Research synthesizer combines findings into SUMMARY.md
4. **Requirements** — Extracted from user responses + research, categorized by scope
5. **Roadmap** — Phase breakdown mapped to requirements, with granularity setting controlling phase count

**Functional Requirements:**
- Questions adapt based on detected project type (web app, CLI, mobile, API, etc.)
- Research agents have web search capability for current ecosystem information
- Granularity setting controls phase count: `coarse` (2-4), `standard` (4-6), `fine` (6-10)
- `--auto` mode extracts all information from the provided document without interactive questioning
- Existing codebase context (from `/gsd-map-codebase`) is loaded if present

---
id: 15
title: Nyquist Validation
group: Quality Assurance Features
---

**Purpose:** Map automated test coverage to phase requirements before any code is written. Named after the Nyquist sampling theorem — ensures a feedback signal exists for every requirement.

**Requirements:**
- REQ-NYQ-01: System MUST detect existing test infrastructure during plan-phase research
- REQ-NYQ-02: System MUST map each requirement to a specific test command
- REQ-NYQ-03: System MUST identify Wave 0 tasks (test scaffolding needed before implementation)
- REQ-NYQ-04: Plan checker MUST enforce Nyquist compliance as 8th verification dimension
- REQ-NYQ-05: System MUST support retroactive validation via `/gsd-validate-phase`
- REQ-NYQ-06: System MUST be disableable via `workflow.nyquist_validation: false`

**Produces:** `{phase}-VALIDATION.md` — Test coverage contract

**Retroactive Validation (`/gsd-validate-phase [N]`):**
- Scans implementation and maps requirements to tests
- Identifies gaps where requirements lack automated verification
- Spawns auditor to generate tests (max 3 attempts)
- Never modifies implementation code — only test files and VALIDATION.md
- Flags implementation bugs as escalations for user to address

---
id: 4
title: Phase Planning
group: Core Features
---

**Command:** `/gsd-plan-phase [N] [--auto] [--skip-research] [--skip-verify]`

**Purpose:** Research the implementation domain and produce verified, atomic execution plans.

**Requirements:**
- REQ-PLAN-01: System MUST spawn a phase researcher to investigate implementation approaches
- REQ-PLAN-02: System MUST produce plans with 2-3 tasks each, sized for a single context window
- REQ-PLAN-03: System MUST structure plans as XML with `<task>` elements containing `name`, `files`, `action`, `verify`, and `done` fields
- REQ-PLAN-04: System MUST include `read_first` and `acceptance_criteria` sections in every plan
- REQ-PLAN-05: System MUST run plan checker verification loop (up to 3 iterations) unless `--skip-verify` is set
- REQ-PLAN-06: System MUST support `--skip-research` flag to bypass research phase
- REQ-PLAN-07: System MUST prompt user to run `/gsd-ui-phase` if frontend phase detected and no UI-SPEC.md exists (UI safety gate)
- REQ-PLAN-08: System MUST include Nyquist validation mapping when `workflow.nyquist_validation` is enabled
- REQ-PLAN-09: System MUST verify all phase requirements are covered by at least one plan before planning completes (requirements coverage gate)
- REQ-PLAN-10: System MUST support an optional `<reversibility rating="reversible|costly|one-way">` element recording how costly a decision would be to undo, and MUST insert a `checkpoint:decision` before the task implementing a `one-way` decision unless `--no-reversibility-gates` is set (`costly` is flagged without blocking; `reversible` and unrated flow normally)

**Produces:**
| Artifact | Description |
|----------|-------------|
| `{phase}-RESEARCH.md` | Ecosystem research findings |
| `{phase}-{N}-PLAN.md` | Atomic execution plans (2-3 tasks each) |
| `{phase}-VALIDATION.md` | Test coverage mapping (Nyquist layer) |

**Plan Structure (XML):**
```xml
<task type="auto">
  <name>Create login endpoint</name>
  <files>src/app/api/auth/login/route.ts</files>
  <action>
    Use jose for JWT. Validate credentials against users table.
    Return httpOnly cookie on success.
  </action>
  <verify>curl -X POST localhost:3000/api/auth/login returns 200 + Set-Cookie</verify>
  <done>Valid credentials return cookie, invalid return 401</done>
</task>
```

**Plan Checker Verification (8 Dimensions):**
1. Requirement coverage — Plans address all phase requirements
2. Task atomicity — Each task is independently committable
3. Dependency ordering — Tasks sequence correctly
4. File scope — No excessive file overlap between plans
5. Verification commands — Each task has testable done criteria
6. Context fit — Tasks fit within a single context window
7. Gap detection — No missing implementation steps
8. Nyquist compliance — Tasks have automated verify commands (when enabled)

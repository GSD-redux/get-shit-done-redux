---
id: 53
title: Assumptions Discussion Mode
group: v1.28 Features
---

**Command:** `/gsd-discuss-phase` with `workflow.discuss_mode: 'assumptions'`

**Purpose:** Replace interview-style questioning with codebase-first assumption analysis.

**Requirements:**
- REQ-ASSUME-01: System MUST analyze codebase to generate structured assumptions before asking questions
- REQ-ASSUME-02: System MUST classify assumptions by confidence level (Confident/Likely/Unclear)
- REQ-ASSUME-03: System MUST produce identical CONTEXT.md format as default discuss mode
- REQ-ASSUME-04: System MUST support confidence-based skip gate (all HIGH = no questions)

**Produces:**
| Artifact | Description |
|----------|-------------|
| `{phase}-CONTEXT.md` | Same format as default discuss mode |

**Process:**
1. **Analyze** — Scan codebase to generate structured assumptions about implementation approach
2. **Classify** — Categorize assumptions by confidence level: Confident, Likely, Unclear
3. **Gate** — If all assumptions are HIGH confidence, skip questioning entirely
4. **Confirm** — Present unclear assumptions as targeted questions to the user
5. **Output** — Produce `{phase}-CONTEXT.md` in identical format to default discuss mode

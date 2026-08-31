---
id: 50
title: Milestone Summary
group: v1.28 Features
---

**Command:** `/gsd-milestone-summary [version]`

**Purpose:** Generate comprehensive project summary from milestone artifacts for team onboarding.

**Requirements:**
- REQ-SUMMARY-01: System MUST aggregate phase plans, summaries, and verification results
- REQ-SUMMARY-02: System MUST work for both current and archived milestones
- REQ-SUMMARY-03: System MUST produce a single navigable document

**Produces:**
| Artifact | Description |
|----------|-------------|
| `MILESTONE-SUMMARY.md` | Comprehensive navigable summary of milestone artifacts |

**Process:**
1. **Collect** — Aggregate phase plans, summaries, and verification results from the target milestone
2. **Synthesize** — Combine artifacts into a single navigable document with cross-references
3. **Output** — Write `MILESTONE-SUMMARY.md` suitable for team onboarding and stakeholder review

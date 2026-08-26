---
id: 49
title: Forensics
group: v1.28 Features
---

**Command:** `/gsd-forensics [description]`

**Purpose:** Post-mortem investigation of failed or stuck GSD workflows.

**Requirements:**
- REQ-FORENSICS-01: System MUST analyze git history for anomalies (stuck loops, long gaps, repeated commits)
- REQ-FORENSICS-02: System MUST check artifact integrity (completed phases have expected files)
- REQ-FORENSICS-03: System MUST generate a markdown report saved to `.planning/forensics/`
- REQ-FORENSICS-04: System MUST offer to create a GitHub issue with findings
- REQ-FORENSICS-05: System MUST NOT modify project files (read-only investigation)

**Produces:**
| Artifact | Description |
|----------|-------------|
| `.planning/forensics/report-{timestamp}.md` | Post-mortem investigation report |

**Process:**
1. **Scan** — Analyze git history for anomalies: stuck loops, long gaps between commits, repeated identical commits
2. **Integrity Check** — Verify completed phases have expected artifact files
3. **Report** — Generate markdown report with findings, saved to `.planning/forensics/`
4. **Issue** — Offer to create a GitHub issue with findings for team visibility

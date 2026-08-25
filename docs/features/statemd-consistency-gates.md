---
id: 69
title: STATE.md Consistency Gates
group: v1.32 Features
---

**Commands:** `state validate [--strict]`, `state sync [--verify]`, `state planned-phase --phase N --plans N`

**Purpose:** Detect and repair drift between STATE.md and the actual filesystem, preventing cascading errors from stale state.

**Requirements:**
- REQ-STATE-01: `state validate` MUST detect drift between STATE.md fields and filesystem reality
- REQ-STATE-02: `state sync` MUST reconstruct STATE.md from actual project state on disk
- REQ-STATE-03: `state sync --verify` MUST perform a dry-run showing proposed changes without writing
- REQ-STATE-04: `state planned-phase` MUST record the state transition after plan-phase completes (Planned/Ready to execute)
- REQ-STATE-05: `state validate` MUST report a `Last activity` value that no reader can parse, rather than validating clean
- REQ-STATE-06: `state validate --strict` MUST reflect `valid` in the process exit status, leaving the default exit status unchanged

**Produces:**
| Artifact | Description |
|----------|-------------|
| Updated `STATE.md` | Corrected state reflecting filesystem reality |

**Process:**
1. **Validate** — Compare STATE.md fields against filesystem (phase directories, plan files, summaries)
2. **Sync** — Reconstruct STATE.md from disk when drift is detected
3. **Transition** — Record post-planning state with plan count for execute-phase readiness

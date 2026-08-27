---
id: 133
title: Skill Surface Budgeting
group: v1.42.1 Features
---

**Purpose:** Let users reduce installed skill and agent surface area when context budget matters.

**Install profiles:**
| Profile | Purpose |
|---------|---------|
| `core` | Minimal main-loop surface |
| `standard` | Core plus common phase-management commands |
| `full` | Complete surface; default |

**Runtime control:** `/gsd-surface` lists profile state and enables, disables, or resets skill clusters without reinstalling.

**Requirements:**
- REQ-SURFACE-01: Installer MUST resolve `--profile=<name>` and persist the active profile in `.gsd-profile`.
- REQ-SURFACE-02: `--minimal` and `--core-only` MUST remain aliases for `--profile=core`.
- REQ-SURFACE-03: Runtime surface state MUST persist outside the install profile marker.

**Reference:** [ADR-0011](adr/0011-skill-surface-budget-module.md)

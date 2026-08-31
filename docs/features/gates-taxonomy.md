---
id: 92
title: Gates Taxonomy
group: v1.34.0 Features
---

**References:** `gsd-core/references/gates.md`
**Agents:** plan-checker, verifier

**Purpose:** Define 4 canonical gate types that structure all workflow decision points, enabling plan-checker and verifier agents to apply consistent gate logic.

**Gate types:**
| Type | Description |
|------|-------------|
| **Confirm** | User approves before proceeding (e.g., roadmap review) |
| **Quality** | Automated quality check must pass (e.g., plan verification loop) |
| **Safety** | Hard stop on detected risk or policy violation |
| **Transition** | Phase or milestone boundary acknowledgment |

**Requirements:**
- REQ-GATES-01: plan-checker MUST classify each checkpoint as one of the 4 gate types
- REQ-GATES-02: verifier MUST apply gate logic appropriate to the gate type
- REQ-GATES-03: Hard stop safety gates MUST never be bypassed by `--auto` flags

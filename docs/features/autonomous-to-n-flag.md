---
id: 70
title: Autonomous `--to N` Flag
group: v1.32 Features
---

**Flag:** `/gsd-autonomous --to N`

**Purpose:** Stop autonomous execution after completing a specific phase, allowing partial autonomous runs.

**Requirements:**
- REQ-TO-01: System MUST stop execution after the specified phase number completes
- REQ-TO-02: System MUST follow the same discuss -> plan -> execute flow for each phase up to N
- REQ-TO-03: `--to N` MUST be combinable with `--from N` for bounded autonomous ranges

**Process:**
1. **Bound** — Set the upper phase limit from `--to N` argument
2. **Execute** — Run autonomous flow for each phase up to and including phase N
3. **Stop** — Halt after phase N completes

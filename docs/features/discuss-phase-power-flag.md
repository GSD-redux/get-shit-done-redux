---
id: 75
title: Discuss-Phase `--power` Flag
group: v1.32 Features
---

**Flag:** `/gsd-discuss-phase --power`

**Purpose:** File-based bulk question answering for discuss-phase, enabling batch input from a prepared answers file.

**Requirements:**
- REQ-POWER-01: System MUST accept a file containing pre-written answers to discussion questions
- REQ-POWER-02: System MUST map answers to the corresponding gray area questions
- REQ-POWER-03: System MUST produce CONTEXT.md identical to interactive discuss-phase

---
id: 62
title: Discuss Chain Mode
group: v1.31 Features
---

**Flag:** `/gsd-discuss-phase <N> --chain`

**Purpose:** Auto-chain discuss, plan, and execute phases in one flow to reduce manual command sequencing.

**Requirements:**
- REQ-CHAIN-01: System MUST auto-chain discuss → plan → execute when `--chain` flag is provided
- REQ-CHAIN-02: System MUST respect all gate settings between chained phases
- REQ-CHAIN-03: System MUST halt the chain if any phase fails

**Process:**
1. **Discuss** — Run discuss-phase to gather context
2. **Plan** — Automatically invoke plan-phase with gathered context
3. **Execute** — Automatically invoke execute-phase with generated plan

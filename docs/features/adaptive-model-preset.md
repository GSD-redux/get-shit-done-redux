---
id: 102
title: Adaptive Model Preset
group: v1.34.0 Features
---

**Config:** `model_profile: "adaptive"`

**Purpose:** Role-based model assignment that automatically selects the appropriate model tier based on the current agent's role, rather than applying a single tier to all agents.

**Requirements:**
- REQ-ADAPTIVE-01: `adaptive` preset MUST assign model tiers based on agent role (planner → quality tier, executor → balanced tier, etc.)
- REQ-ADAPTIVE-02: `adaptive` MUST be selectable via `/gsd-config --profile adaptive`

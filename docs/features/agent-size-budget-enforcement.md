---
id: 119
title: Agent Size-Budget Enforcement
group: v1.37.0 Features
---

**Purpose:** Keep agent prompt files lean with tiered line-count limits enforced in CI. Oversized agents are caught before they bloat context windows in production.

**Requirements:**
- REQ-BUDGET-01: `agents/gsd-*.md` files are classified into three tiers: XL (≤ 1 600 lines), Large (≤ 1 000 lines), Default (≤ 500 lines)
- REQ-BUDGET-02: Tier assignment is declared in the file's YAML frontmatter (`size: xl | large | default`)
- REQ-BUDGET-03: `tests/agent-size-budget.test.cjs` enforces limits and fails CI on violation
- REQ-BUDGET-04: Files without a `size` frontmatter key default to the Default (500-line) limit

**Test file:** `tests/agent-size-budget.test.cjs`

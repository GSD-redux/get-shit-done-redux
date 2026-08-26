---
id: 74
title: Context Reduction
group: v1.32 Features
---

**Part of:** prompt assembly pipeline

**Purpose:** Reduce context prompt sizes through markdown truncation and cache-friendly prompt ordering.

**Requirements:**
- REQ-CTXRED-01: System MUST truncate oversized markdown artifacts to fit within context budgets
- REQ-CTXRED-02: System MUST order prompts for cache-friendly assembly (stable prefixes first)
- REQ-CTXRED-03: Reduction MUST preserve essential information (headings, requirements, task structure)
- REQ-CTXRED-04: Skill `description:` fields MUST be ≤ 100 chars; enforced by `npm run lint:descriptions` (see `scripts/lint-descriptions.cjs` and `tests/skill-frontmatter-contract.test.cjs`)

**Process:**
1. **Measure** — Calculate total prompt size for the workflow
2. **Truncate** — Apply markdown-aware truncation to oversized artifacts
3. **Order** — Arrange prompt sections for optimal KV-cache reuse

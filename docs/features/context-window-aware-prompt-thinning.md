---
id: 114
title: Context-Window-Aware Prompt Thinning
group: v1.36.0 Features
---

**Purpose:** Reduce static prompt overhead by ~40% for models with context windows under 200K tokens. Extended examples and anti-pattern lists are extracted from agent definitions into reference files loaded on demand via `@` required_reading.

**Requirements:**
- REQ-THIN-01: When `CONTEXT_WINDOW < 200000`, executor and planner agent prompts omit inline examples
- REQ-THIN-02: Extracted content lives in `references/executor-examples.md` and `references/planner-antipatterns.md`
- REQ-THIN-03: Standard (200K-500K) and enriched (500K+) tiers are unaffected
- REQ-THIN-04: Core rules and decision logic remain inline; only verbose examples are extracted

**Reference files:** `executor-examples.md`, `planner-antipatterns.md`

---
id: 83
title: Response Language Config
group: v1.32 Features
---

**Config:** `response_language`

**Purpose:** Cross-phase language consistency for non-English users.

**Requirements:**
- REQ-LANG-01: System MUST respect `response_language` setting across all phases and agents
- REQ-LANG-02: Setting MUST propagate to all spawned agents for consistent language output
- REQ-LANG-03: Every workflow MUST carry response-language coverage — through an exact inline directive, a shared `@`-referenced directive (`gsd-core/references/response-language-directive.md`), or inheritance from the parent workflow that dispatches it; enforced in CI by `scripts/lint-response-language-coverage.cjs` (#2529)
- REQ-LANG-04: A covering directive MUST name inter-tool narration, not only the question/prompt surface. A directive names it by using the word "narration" or the phrase "between tool calls"; the class it denotes is the model's running commentary between tool calls, status updates, progress notes and findings included, and enumerating those items without naming the class does not satisfy the rule. A directive worded around questions and prompts alone leaves the model's running commentary in English beside translated answers, which is the defect #2529 reports; `scripts/lint-response-language-coverage.cjs` rejects it (#2529)

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `response_language` | string | (none) | Language code for agent responses (e.g., `"pt"`, `"ko"`, `"ja"`) |

---
id: 91
title: Execution Context Profiles
group: v1.34.0 Features
---

**Config:** `context_profile`

**Purpose:** Select a pre-configured execution context (mode, model, workflow settings) tuned for a specific type of work without manually adjusting individual settings.

**Requirements:**
- REQ-CTX-01: `dev` profile MUST optimize for iterative development (balanced model, plan_check enabled)
- REQ-CTX-02: `research` profile MUST optimize for research-heavy work (higher model tier, research enabled)
- REQ-CTX-03: `review` profile MUST optimize for code review work (verifier and code_review enabled)

**Available profiles:** `dev`, `research`, `review`

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `context_profile` | string | (none) | Execution context preset: `dev`, `research`, or `review` |

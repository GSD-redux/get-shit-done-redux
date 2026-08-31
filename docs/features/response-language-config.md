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

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `response_language` | string | (none) | Language code for agent responses (e.g., `"pt"`, `"ko"`, `"ja"`) |

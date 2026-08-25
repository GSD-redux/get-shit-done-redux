---
id: 140
title: Statusline Context Position
group: v1.42.1 Features
---

**Config key:** `statusline.context_position`

**Purpose:** Keep the context meter visible in narrow terminals.

**Options:**
| Value | Behavior |
|-------|----------|
| `"end"` | Default; render context meter near the line tail |
| `"front"` | Render context meter immediately after the model name |

**Requirements:**
- REQ-STATUSLINE-POS-01: Invalid values MUST be rejected by config validation.
- REQ-STATUSLINE-POS-02: Missing config MUST preserve existing end-position rendering.

**Reference:** [Configuration Reference](CONFIGURATION.md#statusline-settings)

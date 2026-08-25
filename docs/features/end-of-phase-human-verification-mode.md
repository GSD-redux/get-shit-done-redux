---
id: 138
title: End-of-Phase Human Verification Mode
group: v1.42.1 Features
---

**Config key:** `workflow.human_verify_mode`

**Purpose:** Reduce mid-flight human checkpoint interruptions while preserving human verification requirements.

**Behavior:** The default `"end-of-phase"` mode embeds human checks into `<verify><human-check>` blocks for phase review. `"mid-flight"` restores blocking `checkpoint:human-verify` tasks.

**Requirements:**
- REQ-HUMAN-VERIFY-01: `checkpoint:decision` and `checkpoint:human-action` MUST remain blocking regardless of mode.
- REQ-HUMAN-VERIFY-02: Human-needed verification MUST remain pending until the end-of-phase review resolves it.
- REQ-HUMAN-VERIFY-03: Configs without the key MUST use `"end-of-phase"`.

**Reference:** [Checkpoints Reference](../gsd-core/references/checkpoints.md)

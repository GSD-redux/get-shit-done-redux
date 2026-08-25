---
id: 137
title: Fallow Structural Review Pre-Pass
group: v1.42.1 Features
---

**Command:** `/gsd-code-review`

**Config keys:** `code_quality.fallow.*`

**Purpose:** Add an optional structural analysis pass before the agent review.

**Behavior:** When enabled, GSD resolves a `fallow` binary, runs a bounded audit, writes `FALLOW.json`, and embeds structural findings in `REVIEW.md`.

**Requirements:**
- REQ-FALLOW-01: Fallow MUST be opt-in and disabled by default.
- REQ-FALLOW-02: Missing or failing fallow runs MUST produce clear diagnostics.
- REQ-FALLOW-03: Findings larger than the embed budget MUST be skipped with a warning, preserving the raw JSON artifact.

**Reference:** [Configuration Reference](CONFIGURATION.md#code-quality-settings)

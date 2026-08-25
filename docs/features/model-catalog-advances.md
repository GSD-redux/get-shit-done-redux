---
id: 153
title: Model Catalog Advances
group: v1.7.0 Features
---

**Purpose:** Refresh the default model tiers and how models are surfaced.

**Behavior:** Codex/OpenAI defaults advance to the **GPT-5.6 family (Sol / Terra / Luna)** (#2122); the verbose `(1M context)` model suffix collapses to a compact `(1M)` badge (#2160). GSD warns when model config changes without re-running the installer on static-frontmatter runtimes such as Codex and OpenCode (#1688).

**Reference:** [Configuration](CONFIGURATION.md) · [Configure model profiles](how-to/configure-model-profiles.md)

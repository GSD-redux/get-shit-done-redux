---
id: 32
title: Settings Management
group: Utility Features
---

**Command:** `/gsd-settings`

**Purpose:** Interactive configuration of workflow toggles and model profile.

**Requirements:**
- REQ-SETTINGS-01: System MUST present current settings with toggle options
- REQ-SETTINGS-02: System MUST update `.planning/config.json`
- REQ-SETTINGS-03: System MUST support saving as global defaults (`~/.gsd/defaults.json`)

**Configurable Settings:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mode` | enum | `interactive` | `interactive` or `yolo` (auto-approve) |
| `granularity` | enum | `standard` | `coarse`, `standard`, or `fine` |
| `model_profile` | enum | `balanced` | `quality`, `balanced`, `budget`, or `inherit` |
| `models.<phase_type>` | enum | (none) | Per-phase-type tier override (`planning`, `discuss`, `research`, `execution`, `verification`, `completion`). Values: `opus`, `sonnet`, `haiku`, `inherit`. Coarse phase-level tuning that wins over `model_profile` but loses to per-agent `model_overrides`. See [CONFIGURATION.md](CONFIGURATION.md#per-phase-type-models-models--added-in-v140). Added in v1.40 |
| `granularities.<phase_type>` | enum | (none) | Per-phase-type granularity override (`planning`, `discuss`, `research`, `execution`, `verification`, `completion`). Values: `coarse`, `standard`, `fine`. Mirrors `models.<phase_type>` for granularity. See [CONFIGURATION.md](CONFIGURATION.md#core-settings). Added in v1.43 ([#68](https://github.com/open-gsd/gsd-core/issues/68)). `/gsd-plan-phase --granularity <coarse\|standard\|fine>` overrides all config-based granularity for a single invocation (takes precedence over `granularities.planning`, top-level `granularity`, and `planning.granularity`). ([#703](https://github.com/open-gsd/gsd-core/issues/703)) |
| `dynamic_routing.enabled` | boolean | `false` | Master switch for failure-tier escalation. When `true`, agents resolve to `tier_models[default_tier]` and escalate one tier on orchestrator-detected soft failure. Capped by `max_escalations`. See [CONFIGURATION.md](CONFIGURATION.md#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140). Added in v1.40 |
| `workflow.research` | boolean | `true` | Domain research before planning |
| `workflow.plan_check` | boolean | `true` | Plan verification loop |
| `workflow.verifier` | boolean | `true` | Post-execution verification |
| `workflow.auto_advance` | boolean | `false` | Auto-chain discuss→plan→execute |
| `workflow.nyquist_validation` | boolean | `true` | Nyquist test coverage mapping |
| `workflow.ui_phase` | boolean | `true` | UI design contract generation |
| `workflow.ui_safety_gate` | boolean | `true` | Prompt for ui-phase on frontend phases |
| `workflow.node_repair` | boolean | `true` | Autonomous task repair |
| `workflow.node_repair_budget` | number | `2` | Max repair attempts per task |
| `planning.commit_docs` | boolean | `true` | Commit `.planning/` files to git |
| `planning.search_gitignored` | boolean | `false` | Include gitignored files in searches |
| `parallelization.enabled` | boolean | `true` | Run independent plans simultaneously |
| `git.branching_strategy` | enum | `none` | `none`, `phase`, or `milestone` |

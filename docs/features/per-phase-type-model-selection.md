---
id: 126
title: Per-Phase-Type Model Selection
group: v1.41.0 Features
---

**Purpose:** Express model tuning at the phase level (planning, research, execution, verification) without learning the full agent taxonomy. Sits between per-agent `model_overrides` (precise, verbose) and the global `model_profile` tier (coarse, uniform).

**Config key:** `models` in `.planning/config.json`

**Phase-type slots:**

| Slot | Agents assigned |
|------|-----------------|
| `planning` | `gsd-planner`, `gsd-roadmapper`, `gsd-pattern-mapper` |
| `discuss` | `gsd-assumptions-analyzer` |
| `research` | `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-codebase-mapper`, `gsd-ui-researcher` |
| `execution` | `gsd-executor`, `gsd-debugger`, `gsd-doc-writer` |
| `verification` | `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-nyquist-auditor`, `gsd-ui-checker`, `gsd-ui-auditor`, `gsd-doc-verifier`, `gsd-code-reviewer` |
| `completion` | (reserved for future subagent) |

**Accepted values:** `"opus"` / `"sonnet"` / `"haiku"` / `"inherit"`

**Resolution precedence (highest → lowest):**

```text
1. model_overrides[<agent>]
2. dynamic_routing.tier_models[<tier>]   (when enabled)
3. models[<phase_type>]                  (this feature)
4. model_profile
5. Runtime default
```

**Requirements:**
- REQ-PHASE-MODELS-01: Six named `models.*` slots accepted by `config-schema.cjs` and `config-schema.ts`; `config-set` rejects unknown phase-types.
- REQ-PHASE-MODELS-02: Configs without a `models` block behave byte-for-byte identically to pre-v1.41 behavior.
- REQ-PHASE-MODELS-03: `discuss` and `completion` are accepted by the schema for forward compatibility; setting them today is a no-op until a subagent maps to each.

**Reference issue:** [#3023](https://github.com/open-gsd/gsd-core/pull/3030)

---
id: 26
title: Model Profiles
group: Context Engineering Features
---

**Command:** `/gsd-config --profile <quality|balanced|budget|adaptive|inherit>`

**Purpose:** Control which AI model each agent uses, balancing quality vs cost.

**Requirements:**
- REQ-MODEL-01: System MUST support 4 profiles: `quality`, `balanced`, `budget`, `inherit`
- REQ-MODEL-02: Each profile MUST define model tier per agent (see profile table)
- REQ-MODEL-03: Per-agent overrides MUST take precedence over profile
- REQ-MODEL-04: `inherit` profile MUST defer to runtime's current model selection
- REQ-MODEL-04a: `inherit` profile MUST be used when running non-Anthropic providers (OpenRouter, local models) to avoid unexpected API costs
- REQ-MODEL-05: Profile switch MUST be programmatic (script, not LLM-driven)
- REQ-MODEL-06: Model resolution MUST happen once per orchestration, not per spawn

**Profile Assignments:**

| Agent | `quality` | `balanced` | `budget` | `inherit` |
|-------|-----------|------------|----------|-----------|
| gsd-planner | Opus | Opus | Sonnet | Inherit |
| gsd-roadmapper | Opus | Sonnet | Sonnet | Inherit |
| gsd-executor | Opus | Sonnet | Sonnet | Inherit |
| gsd-phase-researcher | Opus | Sonnet | Haiku | Inherit |
| gsd-project-researcher | Opus | Sonnet | Haiku | Inherit |
| gsd-research-synthesizer | Sonnet | Sonnet | Haiku | Inherit |
| gsd-debugger | Opus | Sonnet | Sonnet | Inherit |
| gsd-codebase-mapper | Sonnet | Haiku | Haiku | Inherit |
| gsd-verifier | Sonnet | Sonnet | Haiku | Inherit |
| gsd-plan-checker | Sonnet | Sonnet | Haiku | Inherit |
| gsd-integration-checker | Sonnet | Sonnet | Haiku | Inherit |
| gsd-nyquist-auditor | Sonnet | Sonnet | Haiku | Inherit |

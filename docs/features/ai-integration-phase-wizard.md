---
id: 106
title: AI Integration Phase Wizard
group: v1.35.0 Features
---

**Command:** `/gsd-ai-integration-phase [N]`

**Purpose:** Guide developers through selecting, integrating, and planning evaluation for AI/LLM capabilities in a project phase. Produces a structured `AI-SPEC.md` that feeds into planning and verification.

**Requirements:**
- REQ-AISPEC-01: Wizard MUST present an interactive decision matrix covering framework selection, model choice, and integration approach
- REQ-AISPEC-02: System MUST surface domain-specific failure modes and eval criteria relevant to the project type
- REQ-AISPEC-03: System MUST spawn 3 parallel specialist agents: domain-researcher, framework-selector, and eval-planner
- REQ-AISPEC-04: Output MUST produce `{phase}-AI-SPEC.md` with framework recommendation, implementation guidance, and evaluation strategy

**Produces:** `{phase}-AI-SPEC.md` in the phase directory

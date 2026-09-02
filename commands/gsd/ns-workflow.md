---
name: gsd-workflow
description: "workflow | discuss plan execute verify phase progress"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [discuss-phase, spec-phase, plan-phase, execute-phase, verify-work, phase, progress, next, ultraplan-phase, plan-review-convergence, add-tests, ai-integration-phase, autonomous, fast, mvp-phase, quick, quick-batch]
---

Route to the appropriate phase-pipeline skill based on the user's intent.
Sub-skill names below are post-#2790 consolidated targets — `gsd-phase`
absorbs the former add/insert/remove/edit-phase commands and `gsd-progress`
absorbs the former next/do workflow-advance commands. The reclaimed
`gsd-next` target is the state-aware smart-entry launcher, not the retired
workflow-advance command.

| User wants | Invoke |
|---|---|
| Gather context before planning | gsd-discuss-phase |
| Clarify what a phase delivers | gsd-spec-phase |
| Create a PLAN.md | gsd-plan-phase |
| Execute plans in a phase | gsd-execute-phase |
| Verify built features through UAT | gsd-verify-work |
| Add / insert / remove / edit a phase | gsd-phase |
| Advance to the next logical step | gsd-progress |
| Open the state-aware smart-entry launcher | gsd-next |
| Offload planning to the ultraplan cloud | gsd-ultraplan-phase |
| Cross-AI plan review convergence loop | gsd-plan-review-convergence |
| Generate tests for a completed phase | gsd-add-tests |
| Design an AI-integration phase | gsd-ai-integration-phase |
| Run all remaining phases autonomously | gsd-autonomous |
| Execute a trivial task inline | gsd-fast |
| Plan a phase as a vertical MVP slice | gsd-mvp-phase |
| Execute a quick task with GSD guarantees | gsd-quick |
| Batch several quick-shaped tasks together | gsd-quick-batch |

Invoke the matched skill directly using the Skill tool.

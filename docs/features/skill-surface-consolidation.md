---
id: 122
title: Skill Surface Consolidation
group: v1.40.0 Features
---

**Purpose:** Cut the eager skill-listing overhead by folding 31 micro-skills into 4 new grouped parents and 6 existing parents that absorb sub-operations as flags. Zero functional loss — every removed micro-skill's behavior survives via a flag on a consolidated parent. After consolidation, `commands/gsd/*.md` ships 60 sub-skills (plus 6 namespace meta-skills, see #123).

**Requirements:**
- REQ-CONSOLIDATE-01: Four new grouped skills replace clusters of micro-skills:
  - `/gsd-capture` — folds add-todo (default), note (`--note`), add-backlog (`--backlog`), plant-seed (`--seed`), check-todos (`--list`)
  - `/gsd-phase` — folds add-phase (default), insert-phase (`--insert`), remove-phase (`--remove`), edit-phase (`--edit`)
  - `/gsd-config` — folds settings-advanced (`--advanced`), settings-integrations (`--integrations`), set-profile (`--profile`)
  - `/gsd-workspace` — folds new-workspace (`--new`), list-workspaces (`--list`), remove-workspace (`--remove`)
- REQ-CONSOLIDATE-02: Six existing parents absorb wrap-up / sub-operations as flags: `/gsd-update --sync`, `/gsd-update --reapply`, `/gsd-sketch --wrap-up`, `/gsd-spike --wrap-up`, `/gsd-map-codebase --fast`, `/gsd-map-codebase --query`, `/gsd-code-review --fix`, `/gsd-progress --do`, `/gsd-progress --next`.
- REQ-CONSOLIDATE-03: `/gsd-next` is not the retired workflow-advance command; it is reserved for the state-aware smart-entry launcher. Workflow advancement remains under `/gsd-progress --next`.
- REQ-CONSOLIDATE-04: Deleted micro-skill slash forms (the bare `gsd-add-todo`, `gsd-add-backlog`, `gsd-plant-seed`, `gsd-check-todos`, `gsd-add-phase`, `gsd-insert-phase`, `gsd-remove-phase`, `gsd-edit-phase`, `gsd-new-workspace`, `gsd-list-workspaces`, `gsd-remove-workspace`, `gsd-settings-advanced`, `gsd-settings-integrations`, `gsd-set-profile`, `gsd-sketch-wrap-up`, `gsd-spike-wrap-up`, `gsd-reapply-patches`, `gsd-code-review-fix`, …) MUST resolve to "Unknown command" — no shadow stubs.
- REQ-CONSOLIDATE-05: `autonomous.md` invokes `/gsd-code-review --fix` (was previously calling the deleted `gsd-code-review-fix`).

**Reference issue:** [#2790](https://github.com/open-gsd/gsd-core/issues/2790)

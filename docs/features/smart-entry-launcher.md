---
id: 148
title: Smart Entry Launcher
group: v1.43.0 Features
---

**Command:** `/gsd-next`

**Tool:** `gsd-tools smart-entry [--json]`

**Purpose:** Provide a state-aware front door that reads project/workflow state, classifies the user's situation, presents a short menu, and dispatches exactly one existing GSD command.

**Requirements:**
- REQ-SMART-ENTRY-01: Detection MUST be read-only and deterministic; classification lives in `gsd-tools smart-entry`.
- REQ-SMART-ENTRY-02: The launcher MUST never perform project work directly; it only displays a menu and dispatches one command.
- REQ-SMART-ENTRY-03: The workflow MUST fall back to `/gsd-progress` if detection fails.
- REQ-SMART-ENTRY-04: Each classified situation MUST provide exactly one recommended action and valid slash commands.
- REQ-SMART-ENTRY-05: Text-mode runtimes MUST receive a numbered-list fallback instead of being stranded by interactive UI assumptions.

**Situations:** no project, paused, blocked, verify failed, needs first phase, planning, executing, verify pending, idle stranded, complete, unknown.

**Reference:** [Smart Entry Design](superpowers/specs/2026-06-27-gsd-smart-entry-design.md)

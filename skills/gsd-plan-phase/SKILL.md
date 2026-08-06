---
name: gsd-plan-phase
description: "Create detailed phase plan (PLAN.md) with verification loop"
argument-hint: "[phase] [--auto] [--research] [--skip-research] [--research-phase <N>] [--view] [--gaps] [--skip-verify] [--skip-ui] [--prd <file>] [--ingest <path-or-glob>] [--ingest-format <auto|nygard|madr|narrative>] [--reviews] [--text] [--bounce] [--skip-bounce] [--chunked] [--tdd] [--mvp] [--granularity <coarse|standard|fine>] [--no-tracer] [--no-reversibility-gates]"
effort: high
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
  - WebFetch
  - mcp__context7__*
---

<objective>
Create executable phase prompts (PLAN.md files) for a roadmap phase with integrated research and verification.

**Default flow:** Research (if needed) → Plan → Verify → Done

**Research-only mode (`--research-phase <N>`):** Spawn `gsd-phase-researcher` for phase `N`, write `RESEARCH.md`, then exit before the planner runs. Useful for cross-phase research, doc review before committing to a planning approach, and correction-without-replanning loops where iterating on research alone is dramatically cheaper than re-spawning the planner. Replaces the deleted research-phase command (#3042).

**Research-only modifiers:**
- **No flag** — when `RESEARCH.md` already exists, auto-uses it: emits a one-line notice and exits cleanly, no prompt.
- **`--research`** — force-refresh: re-spawn the researcher unconditionally, no prompt. Bypasses the existing-RESEARCH.md auto-use path.
- **`--view`** — view-only: print existing `RESEARCH.md` to stdout. Does not spawn the researcher. Cheapest mode for the correction-without-replanning loop. If no `RESEARCH.md` exists yet, errors with a hint to drop `--view`.

**Orchestrator role:** Parse arguments, validate phase, research domain (unless skipped), spawn gsd-planner, verify with gsd-plan-checker, iterate until pass or max iterations, present results.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/plan-phase.md
@~/.claude/gsd-core/references/ui-brand.md
</execution_context>

<runtime_note>
**Copilot (VS Code):** Use `vscode_askquestions` wherever this workflow calls `AskUserQuestion`. They are equivalent — `vscode_askquestions` is the VS Code Copilot implementation of the same interactive question API. Do not skip questioning steps because `AskUserQuestion` appears unavailable; use `vscode_askquestions` instead.
</runtime_note>

<context>
Phase number: $ARGUMENTS (optional — when omitted, the orchestrating workflow reads ROADMAP.md and selects the next unplanned phase; `gsd-tools.cjs` itself has no auto-detect feature and requires an explicit phase number)

**Flags:**
- `--research` — Force re-research even if RESEARCH.md exists
- `--skip-research` — Skip research, go straight to planning
- `--gaps` — Gap closure mode (reads VERIFICATION.md, skips research)
- `--skip-verify` — Skip verification loop
- `--prd <file>` — Use a PRD/acceptance criteria file instead of discuss-phase. Parses requirements into CONTEXT.md automatically. Skips discuss-phase entirely.
- `--ingest <path-or-glob>` — Use one or more ADR files instead of discuss-phase. Parses locked decisions + scope fences into CONTEXT.md automatically. Skips discuss-phase entirely.
- `--ingest-format <auto|nygard|madr|narrative>` — Optional ADR parser format override (`auto` default).
- `--reviews` — Replan incorporating cross-AI review feedback from REVIEWS.md (produced by `/gsd-review`)
- `--text` — Use plain-text numbered lists instead of TUI menus (required for `/rc` remote sessions)
- `--mvp` — MVP enrichment on top of the default tracer-first ordering: frames the phase goal as a user story and, on Phase 1 of a new project, also emits `SKELETON.md` (Walking Skeleton). Vertical slicing itself is now the default (see `--no-tracer`); `--mvp` no longer *turns it on*. Can be persisted on a phase via `**Mode:** mvp` in ROADMAP.md.
- `--no-tracer` — Opt out of the default **tracer-first** decomposition and plan horizontal layers (the legacy default). By default every plan LEADS with one production-quality end-to-end `tracer` slice that is verified before any expansion task.
- `--no-reversibility-gates` — Suppress the human checkpoint that a **one-way-door** decision normally earns, for runs you intend to leave unattended. By default a decision rated `one-way` (undo needs a migration, breaks a published contract, or is impossible) gets a `checkpoint:decision` before the task implementing it. Ratings are still recorded on tasks and `costly` items still flagged — the flag changes what stops the run, not what the plan remembers.

Normalize phase input in step 2 before any directory lookups.
</context>

<process>
Execute end-to-end.
Preserve all workflow gates (validation, research, planning, verification loop, routing).
</process>

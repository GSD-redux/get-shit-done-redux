---
id: 163
title: Read-Only Planning Snapshot (`planning inspect`)
group: v1.7.0 Features
---

**Command:** `gsd-tools query planning inspect`

**Purpose:** Give downstream consumers — harness UIs, mission-control surfaces, dashboards, bots — one schema-versioned JSON document describing everything `.planning/` knows, so nothing outside gsd-core has to parse `ROADMAP.md` / `REQUIREMENTS.md` / `*-PLAN.md` / `*-SUMMARY.md` a second time. gsd-core is the single source of `.planning/` truth; a second parser is a second answer.

**Requirements:**
- REQ-INSP-01: `PLANNING_INSPECT_SCHEMA_VERSION = 1` is emitted as `schema_version`. Consumers MUST reject any other value rather than best-effort-parse an unknown shape.
- REQ-INSP-02: Read-only. The command mutates no planning state, and mutates nothing on disk, under any input.
- REQ-INSP-03: Unknown or conflicting evidence serializes as `null` / `"unknown"` with a coded entry in `diagnostics[]` — never inferred, reconciled, or defaulted. Every key is always present; a key is never omitted to signal absence.
- REQ-INSP-04: Argument errors fail loud (non-zero exit, typed `ERROR_REASON`); data gaps do not. v1 takes no arguments, and a stray positional or unknown flag is a usage error rather than a silently-ignored one.
- REQ-INSP-05: Roadmap acceptance, verification status, and UAT items are reported side by side per phase and are never folded into a single verdict. A ROADMAP checkbox carries `authoritative: false` — completion is derived from disk state.
- REQ-INSP-06: `accepted_phases` and `completed_plans` are independent fractions. `percent` is `null` whenever the scope is not `complete`, per the same rule the roadmap and progress surfaces follow.
- REQ-INSP-07: Payloads over ~50 KB use the existing `@file:` spill channel, resolved transparently before stdout.

**Why it does not simply serialize the internal snapshot.** `PlanningSnapshot` (the diagnostic-rule subject introduced by ADR-3180 §8.1) is deliberately additive and still growing — four fields at Phase 10, twenty-plus by Phase 12. Handing that shape to external consumers would freeze an internal contract by accident. `planning inspect` declares its own flat schema and maps into it, so a field added to `PlanningSnapshot` never changes what this command emits.

**Composed, never re-derived.** Milestone identity and phase enumeration arrive via `buildPlanningSnapshot`; completion from `isPhaseComplete` (disk-strict); live-plan counting from `scanPhasePlans`; the percentage arithmetic from `clampPercent`; STATE fields from `stateFieldValue`; plan bodies from the Plan Document Module; requirement IDs from `parseRequirements`; UAT items from `parseUatItems`. Markdown structure is read through the Markdown Sectionizer and Markdown Table Model seams, so the Traceability table is resolved by column name against its registered schema rather than by a position-anchored regex.

**Known limit — task-scoped file provenance.** A `<task>` declares the files it plans to touch, but `SUMMARY.md`'s `## Files Created/Modified` describes the whole plan. Spreading that list across a plan's tasks would be inference, so a task's `changed_files` is populated only where the summary attributes files to that specific task; otherwise it is `null` with `provenance: "plan_scoped"`. Closing this needs a change to the SUMMARY format, not to the reader.

**Reference:** [CLI Tools](CLI-TOOLS.md#planning-inspect) · [Consume the planning snapshot](how-to/consume-the-planning-snapshot.md)

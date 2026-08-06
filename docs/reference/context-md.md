# CONTEXT.md schema reference

A per-phase `CONTEXT.md` is GSD Core's carrier for implementation decisions captured during `/gsd-discuss-phase`. It is the primary upstream input for both the research and planning agents. This page documents its structure. See [docs index](../README.md).

---

## Overview

Every phase that has been through the discuss workflow produces one `CONTEXT.md` at:

```
.planning/phases/<NN>-<slug>/<NN>-CONTEXT.md
```

For example: `.planning/phases/03-post-feed/03-CONTEXT.md`.

The file is produced by `write_context` in `gsd-core/workflows/discuss-phase.md` (or its PRD / ADR ingest express paths). It is never edited by hand during normal operation — the discuss-phase workflow writes it and downstream agents read it as a sealed source of truth.

---

## Frontmatter

`CONTEXT.md` carries no YAML frontmatter. Metadata is inline at the top of the body:

```markdown
# Phase [X]: [Name] - Context

**Gathered:** [ISO date]
**Status:** Ready for planning
```

The `Status` field is always `Ready for planning` when the file is first written. It is not updated after creation.

---

## Block structure

The body is divided into named XML-style blocks. The blocks appear in a fixed order and are read by downstream agents by block name, not by line number.

| Block | Purpose | Populated by | Consumed by |
|---|---|---|---|
| `<domain>` | States the phase boundary — what this phase delivers and what is explicitly out of scope. Anchors the scope guardrail throughout planning and execution. | `discuss-phase` (from ROADMAP.md phase goal) | `gsd-planner`, `gsd-plan-checker` (scope compliance) |
| `<spec_lock>` | Present only when a `*-SPEC.md` was found by the `check_spec` step. Lists locked requirement counts and scope boundaries; agents are directed to read `SPEC.md` directly for full requirements. | `discuss-phase` (conditional) | `gsd-planner` (reads SPEC.md rather than re-reading requirements here) |
| `<decisions>` | Implementation decisions captured from the discussion, keyed with `D-NN` identifiers. Categories emerge from what was actually discussed rather than a fixed taxonomy. Includes a `Claude's Discretion` sub-section for areas the user delegated. | `discuss-phase` (interactive discussion) | `gsd-planner` (locked decisions must be implemented), `gsd-plan-checker` (Dimension 7 compliance) |
| `<canonical_refs>` | Full relative paths to every spec, ADR, feature doc, or design doc relevant to this phase. Mandatory — every CONTEXT.md must have this section. Agents must read listed files before planning or implementing. | `discuss-phase` (accumulated from ROADMAP.md refs + user references during discussion + codebase scout) | `gsd-phase-researcher`, `gsd-planner` |
| `<code_context>` | Reusable assets, established patterns, and integration points discovered during the `scout_codebase` step. Guides agents towards existing code rather than re-implementing. | `discuss-phase` (codebase scout) | `gsd-planner`, `gsd-phase-researcher` |
| `<specifics>` | Concrete "I want it like X" references, product comparisons, or particular examples captured verbatim during discussion. | `discuss-phase` (freeform user input) | `gsd-planner` |
| `<deferred>` | Ideas that arose in discussion but belong in other phases. Preserved so they are not lost. Includes a `Reviewed Todos` sub-section when todos were reviewed but not folded into scope. | `discuss-phase` (scope-creep redirect) | Not consumed by automated agents; human reference only |

---

## Decision identifier format

Every decision in `<decisions>` carries a sequential `D-NN` identifier:

```markdown
### Layout style
- **D-01:** Card-based layout, not timeline or list
- **D-02:** Each card shows: author avatar, name, timestamp, full post content, reaction counts
```

Identifiers are scoped to the phase. `D-01` in Phase 3 is unrelated to `D-01` in Phase 7. The plan-checker (Dimension 7) verifies that every `D-NN` is addressed by at least one task action in the generated plans.

---

## Canonical references

The `<canonical_refs>` block is **mandatory**. Agents that find it absent treat the CONTEXT.md as incomplete and surface a warning. Entries are grouped by topic and carry a full relative path plus a brief statement of what the file decides or defines:

```markdown
<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Feed display
- `docs/features/social-feed.md` — Feed requirements, post card fields, engagement display rules
- `docs/decisions/adr-012-infinite-scroll.md` — Scroll strategy decision, virtualisation requirements

### Empty states
- `docs/design/empty-states.md` — Empty state patterns, illustration guidelines

</canonical_refs>
```

When a project has no external specs, the section states this explicitly:

```
No external specs — requirements fully captured in decisions above
```

Inline mentions like "see ADR-019" scattered in `<decisions>` are insufficient; agents need the full path in the dedicated section.

---

## Decision Coverage Gate relationship

The plan-checker's **Dimension 7: Context Compliance** enforces a coverage gate after planning:

1. Every `D-NN` identifier in `<decisions>` must appear in at least one plan task's `<action>` or rationale.
2. No task may implement anything listed in `<deferred>` (scope creep).
3. `Claude's Discretion` areas are exempted from this check — the planner may choose freely.

A CONTEXT.md where decisions survive into plans is considered compliant. A CONTEXT.md whose decisions are silently dropped or partially delivered triggers **Dimension 7b: Scope Reduction Detection**, which is always a BLOCKER.

---

## SPEC.md integration

When `/gsd-spec-phase` has been run before discussing a phase, the `check_spec` step finds the `*-SPEC.md` file and activates `<spec_lock>`:

```markdown
<spec_lock>
## Requirements (locked via SPEC.md)

**12 requirements are locked.** See `03-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `03-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):** [copied from SPEC.md Boundaries]
**Out of scope (from SPEC.md):** [copied from SPEC.md Boundaries]

</spec_lock>
```

When `<spec_lock>` is present, `<decisions>` contains only implementation decisions from the discussion — the "how", not the "what". Requirements are not duplicated between the two files.

---

## Footer

Every CONTEXT.md ends with an identity footer:

```markdown
---

*Phase: XX-name*
*Context gathered: [date]*
```

---

## Related

- [PLAN.md schema](plan-md.md)
- [Planning artifacts](planning-artifacts.md)
- [Discuss modes](../workflow-discuss-mode.md)
- [docs index](../README.md)

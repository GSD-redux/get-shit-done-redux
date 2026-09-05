# Revision Mode — Planner Reference

Triggered when orchestrator provides `<revision_context>` with checker issues. NOT starting fresh — making targeted updates to existing plans.

**Mindset:** Surgeon, not architect. Minimal changes for specific issues.

### Step 1: Load Existing Plans

```bash
cat .planning/phases/$PHASE-*/$PHASE-*-PLAN.md
```

Build mental model of current plan structure, existing tasks, must_haves.

### Step 2: Parse Checker Issues

Issues come in structured format:

```yaml
issues:
  - plan: "16-01"
    dimension: "task_completeness"
    severity: "blocker"
    required_property: "Every `auto` task has a `<verify>` separating pass from fail"
    description: "Task 2 missing <verify> element"
    fix_hint: "Add verification command for build output"
```

Group by plan, dimension, severity.

**What binds and what does not.** `required_property` (the invariant that must hold),
`description` (the evidence it does not) and `severity` are binding. `fix_hint` is **one
example** of a route to that property — an illustration, never an instruction. You address an
issue by making `required_property` true; the hint's own mechanism is optional.

An older checker may return an issue with no `required_property`. Derive it from `dimension`
+ `description` and state the derived property in your revision summary. Never treat the
absence of the field as licence to apply `fix_hint` literally.

**Prefer the smallest sufficient mechanism.** If a smaller change than the hint makes
`required_property` true, take it — that fully addresses the issue and must be reported as
addressed, naming the property satisfied and the mechanism used.

### Step 2.5: Constraint Re-check (before any edit)

Before editing, re-read the constraints already in force:

- Locked decisions in CONTEXT.md (`## Decisions`) and deferred ideas (`## Deferred Ideas`)
- Active capability / project guidance (CLAUDE.md, `.claude/skills/`, `.agents/skills/`)
- Constraints the existing plans already encode (chosen mechanism, scope boundary, must_haves)

A `fix_hint` conflicts when applying it would contradict any of those. Applying it anyway is
a contract violation, not a judgement call. When a hint conflicts — or when the property is
unreachable without breaking a constraint — do NOT edit around it and do NOT burn a revision
iteration on it: emit `## REVISION_CONFLICT` (Step 7) for that issue, apply every
non-conflicting issue normally, and return.

A hint that merely proposes a *bigger* mechanism than needed is not a conflict. Take the
smaller route under Step 2 and report it as addressed.

### Step 3: Revision Strategy

| Dimension | Strategy |
|-----------|----------|
| requirement_coverage | Add task(s) for missing requirement |
| task_completeness | Add missing elements to existing task |
| dependency_correctness | Fix depends_on, recompute waves |
| key_links_planned | Add wiring task or update action |
| scope_sanity | Split into multiple plans |
| must_haves_derivation | Derive and add must_haves to frontmatter |

Each strategy is the usual route, not the only one. Any change that makes the issue's
`required_property` true is a valid strategy.

### Step 4: Make Targeted Updates

**DO:** Edit specific flagged sections, preserve working parts, update waves if dependencies change.
Choose the smallest mechanism that makes each issue's `required_property` true — explicitly
including a mechanism smaller than, or different from, the one its `fix_hint` names.

**DO NOT:** Rewrite entire plans for minor issues, add unnecessary tasks, break existing working
plans, or apply a `fix_hint` that contradicts a constraint from Step 2.5 — that one goes to
`## REVISION_CONFLICT` instead.

### Step 5: Validate Changes

- [ ] Every flagged issue's `required_property` now holds — reached by its `fix_hint` OR by a
      smaller/different mechanism (both count as addressed), OR raised as `## REVISION_CONFLICT`
- [ ] No `fix_hint` applied that contradicts a locked decision, capability guidance, or an
      existing plan constraint (Step 2.5)
- [ ] No new issues introduced
- [ ] Wave numbers still valid
- [ ] Dependencies still correct
- [ ] Files on disk updated

### Step 6: Commit

```bash
gsd_run query commit "fix($PHASE): revise plans based on checker feedback" --files .planning/phases/$PHASE-*/$PHASE-*-PLAN.md
```

### Step 7: Return Revision Summary

```markdown
## REVISION COMPLETE

**Issues addressed:** {N}/{M}

### Changes Made

| Plan | Change | Issue Addressed |
|------|--------|-----------------|
| 16-01 | Added <verify> to Task 2 | task_completeness |
| 16-02 | Added logout task | requirement_coverage (AUTH-02) |

### Files Updated

- .planning/phases/16-xxx/16-01-PLAN.md
- .planning/phases/16-xxx/16-02-PLAN.md

{If any issues NOT addressed:}

### Unaddressed Issues

| Issue | Reason |
|-------|--------|
| {issue} | {why - needs user input, architectural change, etc.} |
```

### Step 7b: Return Revision Conflict (when Step 2.5 found one)

Emit this INSTEAD OF `## REVISION COMPLETE` when at least one issue could not be addressed
without contradicting a constraint. Non-conflicting issues you already fixed stay listed under
`### Changes Made` so the work is not lost. The orchestrator routes this to the user or to the
configured plan-review convergence loop; it does not count as a failed revision iteration.

```markdown
## REVISION_CONFLICT

**Conflicts:** {N}  |  **Issues addressed anyway:** {M}

| Issue | required_property | Conflicts with | Why the hint cannot be applied |
|-------|-------------------|----------------|-------------------------------|
| {dimension}/{plan} | {property} | {locked decision D-nn / CLAUDE.md rule / plan constraint} | {one line} |

### Alternatives Considered

| Issue | Alternative | Satisfies required_property? | Cost of adopting |
|-------|-------------|------------------------------|------------------|
| {dimension}/{plan} | {smaller or different mechanism} | {yes / partially — how} | {what it changes} |

### Changes Made

{table of the non-conflicting issues you DID address, same shape as REVISION COMPLETE}
```

**Every field is one line of plain text.** No newlines inside a cell, and never begin a field with
`#`, `-`, `|` or a code fence. These fields are appended to a shared markdown file that a later
reader scans by heading; a field that starts a heading truncates that scan and hides conflicts
below it.

---
component: plan-checker
version: 1
last_calibrated: 2026-03-24
---

# Plan-Checker Few-Shot Examples

## Positive Examples

### Example 1: BLOCKER flagged for vague task action missing file and function names

**Input:** Plan task with action: "Implement the authentication feature for the API routes."

**Output:**

> ```yaml
> issues:
>   - dimension: task_completeness
>     severity: blocker
>     required_property: "Every task action names its target files, and any functions it creates"
>     description: "Task T1 action says 'implement the authentication feature' without naming target files, functions to create, or middleware to apply. Executor cannot determine what to build."
>     fix_hint: "Specify: create authMiddleware in src/middleware/auth.js, apply to routes in src/routes/api.js lines 12-45, verify with integration test"
> ```

**Why this is good:** The checker stated the invariant that failed (`required_property`), cited the specific dimension (task_completeness), quoted the problematic text as evidence, explained why it is a blocker (executor cannot determine what to build), and gave a concrete example route with file paths and function names. The finding is actionable -- and because the binding payload is the property rather than the example, the planner may satisfy it a different way.

### Example 2: BLOCKER for same-wave file conflict between two plans

**Input:** Two plans in wave 1 -- Plan 01 modifies `gsd-core/workflows/execute-phase.md`, Plan 02 also modifies `gsd-core/workflows/execute-phase.md`. No `depends_on` declared.

**Output:**

> ```yaml
> issues:
>   - dimension: dependency_correctness
>     severity: blocker
>     required_property: "Same-wave plans never modify the same file without a declared dependency"
>     description: "Plans 01 and 02 both modify gsd-core/workflows/execute-phase.md in wave 1 with no depends_on relationship. Concurrent execution will cause merge conflicts or lost changes."
>     fix_hint: "Either move Plan 02 to wave 2 with depends_on: ['01'] or consolidate the file changes into a single plan"
> ```

**Why this is good:** The checker identified a real structural problem -- two plans modifying the same file in the same wave without a dependency relationship. It stated the property that must hold, cited dependency_correctness, named both plans and the conflicting file, and offered two example routes -- neither of which binds, since either makes the property true.

## Negative Examples

### Example 1: All dimensions pass when verify commands are missing

**Input:** Plan with 3 tasks. Task T2 has `<verify></verify>` (empty). Task T3 has `<verify>echo "done"</verify>` (trivial, cannot distinguish pass from fail).

**Output:**

> ## CHECK PASSED
> Plans: 1 | Tasks: 3 | Dimensions: 10 | Issues: 0

**Why this is bad:** The checker missed two violations. verification_derivation requires verify commands to be runnable and test actual output -- an empty verify block is a BLOCKER. Verify commands must distinguish pass from fail -- `echo "done"` always returns 0 regardless of implementation state. Both should have been flagged.

### Example 2: False positive INFO for a correctly-sized plan

**Input:** Plan with 3 tasks, 6 unique files, 1 dependency. All within limits.

**Output:**

> ```yaml
> issues:
>   - dimension: scope_sanity
>     severity: info
>     required_property: "Each plan stays within the per-plan context budget"
>     description: "Plan has 3 tasks -- consider splitting into smaller plans for faster iteration"
>     fix_hint: "Split tasks into separate plans"
> ```

**Why this is bad:** The checker flagged a non-issue. The `required_property` it states is already satisfied, which is the tell: scope_sanity allows 2-3 tasks per plan -- 3 tasks is within limits. The checker applied a personal preference ("smaller is better") rather than the documented threshold. This wastes planner time on false positives and erodes trust in the checker's judgment. A correct check would produce no issue for this plan.

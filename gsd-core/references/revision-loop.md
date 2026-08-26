# Revision Loop Pattern

Standard pattern for iterative agent revision with feedback. Used when a checker/validator finds issues and the producing agent needs to revise its output.

---

## Pattern: Check-Revise-Escalate (max 3 iterations)

This pattern applies whenever:
1. An agent produces output (plans, imports, gap-closure plans)
2. A checker/validator evaluates that output
3. Issues are found that need revision

### Flow

```
prev_issue_count = Infinity
iteration = 0

LOOP:
  1. Run checker/validator on current output
  2. Read checker results
  3. If PASSED or only INFO-level issues:
     -> Accept output, exit loop
  4. If BLOCKER or WARNING issues found:
     a. If iteration + 1 > 3:
        -> Escalate to user (see "After 3 Iterations" below)
     b. Parse issue count from checker output
     c. If issue_count >= prev_issue_count:
        -> Escalate to user: "Revision loop stalled (issue count not decreasing)"
     d. prev_issue_count = issue_count
     e. Re-spawn the producing agent with checker feedback appended
     f. If the agent returns REVISION_CONFLICT:
        -> If it names the same required_property as the previous conflict:
             escalate as a stall (the resolution did not take) -- bounds this path
           Else: resolve it (see "Conflict Return" below) and go to step e.
             Do NOT increment iteration -- the conflict was not a failed attempt.
     g. iteration += 1
     h. After revision completes, go to LOOP

The increment is step g, AFTER the producing agent returns — deliberately, not as written before
#3771. An iteration counted at step a is already spent by the time a REVISION_CONFLICT comes back,
so it cannot then be withheld, and the cap would punish the agent for correctly refusing to apply
incompatible advice.
```

### Issue Count Tracking

Track the number of BLOCKER + WARNING issues returned by the checker on each iteration. If the count does not decrease between consecutive iterations, the producing agent is stuck and further iterations will not help. Break early and escalate to the user.

Display iteration progress before each revision spawn:
`Revision iteration {N}/3 -- {blocker_count} blockers, {warning_count} warnings`

### Re-spawn Prompt Structure

When re-spawning the producing agent for revision, pass the checker's YAML-formatted issues. The checker's output contains a `## Issues` heading followed by a YAML block. Parse this block and pass it verbatim to the revision agent.

The field names are the plan-checker's schema (`agents/gsd-plan-checker.md` → `<issue_structure>`):
`plan`, `dimension`, `severity`, `required_property`, `description`, `task`, `fix_hint`. There is no
`suggested_fix` field and no `finding` or `affected_field` field — those names were drift, and every
producer now emits the schema above.

```
<checker_issues>
The issues below are in YAML format. Each has: dimension, severity,
required_property, description, fix_hint.

BINDING: required_property (the invariant that must hold), description (the
evidence it does not), severity. NON-BINDING: fix_hint -- ONE example route to
the property, never an instruction.

Satisfy the required_property of ALL BLOCKER issues. Satisfy WARNING issues
where feasible.

{YAML issues block from checker output -- passed verbatim}
</checker_issues>

<revision_instructions>
Address ALL BLOCKER and WARNING issues identified above.
- For each BLOCKER: make required_property true. Its fix_hint is one example
  route; a smaller or different mechanism that makes the same property true
  addresses the issue in full -- report which mechanism you used.
- For each WARNING: address or explain why it's acceptable
- Before editing, re-check locked decisions, active capability guidance, and
  constraints the existing output already encodes. If a fix_hint would
  contradict one of those, or the property is unreachable without breaking one,
  do NOT apply it and do NOT work around it: return REVISION_CONFLICT naming
  the conflict and the alternatives considered, having addressed every
  non-conflicting issue.
- Do NOT introduce new issues while fixing existing ones
- Preserve all content not flagged by the checker
This is revision iteration {N} of max 3. Previous iteration had {prev_count}
issues. You must reduce the count or the loop will terminate.
</revision_instructions>
```

### Conflict Return (REVISION_CONFLICT)

A revision agent that returns `REVISION_CONFLICT` has not failed and has not stalled. Handle it
BEFORE the iteration counter and the stall check — a conflict is not resolvable by re-running the
same loop, so spending retry budget on it only exhausts the cap:

1. Do NOT increment `iteration` and do NOT update `prev_issue_count`.
2. Present the conflict and its alternatives to the user and ask which to take
   (pattern: `gsd-core/references/gate-prompts.md`). Options: adopt a named alternative /
   override the named constraint and apply the hint / amend the constraint itself. Each option
   resolves the conflict. Accepting the output with the blocker still open is NOT offered here —
   the blocking `required_property` still fails, and that choice belongs to the cap escalation.
3. Re-spawn the producing agent with the chosen resolution, then resume the loop.

**Bounded.** Not incrementing `iteration` must not make this path unbounded: if the agent returns
a conflict naming the SAME `required_property` twice in a row, the chosen resolution did not take.
Stop re-spawning, report it as a stall, and escalate through the same gate the iteration cap uses.

Asking the user is the route, in every workflow. A host that participates in an arbitration loop
also RECORDS the conflict where that loop will see it — `plan-phase` appends a `- [ ]` line to the
phase REVIEWS.md when `workflow.plan_review_convergence` is enabled, so an open conflict blocks
convergence even if this run is abandoned — but recording is in addition to asking, never instead
of it. No workflow hands a conflict to a loop and returns.

### After 3 Iterations

If issues persist after 3 revision cycles:

1. Present remaining issues to the user
2. Use gate prompt (pattern: yes-no from `gsd-core/references/gate-prompts.md`):
   question: "Issues remain after 3 revision attempts. Proceed with current output?"
   header: "Proceed?"
   options:
     - label: "Proceed anyway"   description: "Accept output with remaining issues"
     - label: "Adjust approach"  description: "Discuss a different approach"
3. If "Proceed anyway": accept current output and continue
4. If "Adjust approach" or "Other": discuss with user, then re-enter the producing step with updated context

### Workflow-Specific Variations

| Workflow | Producer Agent | Checker Agent | Notes |
|----------|---------------|---------------|-------|
| plan-phase | gsd-planner | gsd-plan-checker | Revision prompt via planner-revision.md |
| execute-phase | gsd-executor | gsd-verifier | Post-execution verification |
| discuss-phase | orchestrator | gsd-plan-checker | Inline revision by orchestrator |

---

## Important Notes

- **INFO-level issues are always acceptable** -- they don't trigger revision
- **Each iteration gets a fresh agent spawn** -- don't try to continue in the same context
- **Checker feedback must be inlined** -- the revision agent needs to see exactly what failed
- **Don't silently swallow issues** -- always present the final state to the user after exiting the loop
- **A remediation hint is an example, not an order** -- an issue satisfied through a smaller valid
  mechanism is addressed, and counts as resolved for the issue-count and stall checks

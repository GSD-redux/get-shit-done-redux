# Reviews Mode — Planner Reference

Triggered when orchestrator sets Mode to `reviews`. Replanning from scratch with REVIEWS.md feedback as additional context.

**Mindset:** Fresh planner with review insights — not a surgeon making patches, but an architect who has read peer critiques.

**Execution contract:** REVIEWS.md is audit trail and feedback input, not a second execution contract. /gsd:execute-phase primarily consumes PLAN.md plus the normal phase context. Every current actionable review finding must therefore be incorporated into the relevant PLAN.md or explicitly deferred/rejected in that PLAN.md.

### Step 1: Load REVIEWS.md
Read the reviews file from `<required_reading>`. Parse:
- Per-reviewer feedback (strengths, concerns, suggestions)
- Consensus Summary (agreed concerns = highest priority to address)
- Divergent Views (investigate, make a judgment call)

### Step 2: Categorize Feedback
Group review feedback into:
- **Must address**: HIGH severity consensus concerns
- **Must represent in PLAN.md**: actionable MEDIUM/LOW findings that require task, action, acceptance criteria, verify command, must_haves, threat-model, artifact, stale-path, or execution-contract changes
- **Should address**: MEDIUM severity concerns from 2+ reviewers that improve quality but do not change the executable contract
- **Consider**: Individual reviewer suggestions, LOW severity items

### Step 3: Plan Fresh with Review Context
Create new plans following the standard planning process, but with review feedback as additional constraints:
- Each HIGH severity consensus concern MUST have a task that addresses it
- Each current actionable MEDIUM/LOW finding MUST either appear in the relevant PLAN.md executable content or have a deferral/rejection rationale in that PLAN.md
- Note in task actions: "Addresses review concern: {concern}" for traceability

### Step 4: Return
Use standard PLANNING COMPLETE return format, adding a reviews section:

```markdown
### Review Feedback Addressed

| Concern | Severity | How Addressed |
|---------|----------|---------------|
| {concern} | HIGH | Plan {N}, Task {M}: {how} |

### Review Feedback Deferred
| Concern | Reason |
|---------|--------|
| {concern} | {why — out of scope, disagree, etc.} |
```

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

### Step 5: Write the ledger into PLAN.md (#3806)

The two tables above are not only the planner's return payload — they are also the **canonical
Review Dispositions Ledger**, and they belong in the affected PLAN.md itself, in this exact shape.
`gsd-core/workflows/plan-phase.md` (`<review_incorporation_contract>`) and
`agents/gsd-plan-checker.md` (Review Incorporation dimension) both point back to this section for
the ledger's shape rather than restating it — this is the one place it is defined.

## Review Dispositions Ledger

Add or extend a `## Review Dispositions Ledger` section in the affected PLAN.md, containing one
`### Round {N} — {REVIEWS_sha}` subsection per reviews-mode round that touched this plan, where
`{REVIEWS_sha}` is the commit that wrote the REVIEWS.md snapshot being ruled on (the short sha from
`git log -1 --format=%h -- <phase_dir>/<NN>-REVIEWS.md`, after `workflows/review.md`'s REVIEWS.md
commit step). Under each round heading, use the two tables from Step 4 above, unchanged in shape:

```markdown
## Review Dispositions Ledger

### Round 1 — a1b2c3d

### Review Feedback Addressed
| Concern | Severity | How Addressed |
|---------|----------|---------------|
| {concern} | HIGH | Plan {N}, Task {M}: {how} |

### Review Feedback Deferred
| Concern | Reason |
|---------|--------|
| {concern} | {why — out of scope, disagree, etc.} |
```

**Anchoring.** Any reference to a specific REVIEWS.md line cites `L##@{REVIEWS_sha}` (e.g.
`L32@a1b2c3d`) — a bare line number is meaningless once the next round rewrites REVIEWS.md
wholesale. `{Concern}` and `{Reason}` stay free text; do not invent a reviewer/severity enum — the
reviewer roster is capability-owned and open to third-party additions (see each capability's
`reviewer.reviewsSection`).

**Append-only.** A later round never edits or deletes a prior round's tables. To overturn a prior
round's verdict, add a new row in the current round's table whose Reason/How Addressed names the
round and concern it supersedes (e.g. "Supersedes Round 1 Deferred: {concern} — now addressed in
Plan 3").

**Out of scope for this contract.** A deterministic lint/check verb that mechanically enforces this
shape is a separate, later addition (#3806 part 2) — this section defines the format only. Legacy
PLAN.md content written before this convention existed is not migrated or flagged by it.

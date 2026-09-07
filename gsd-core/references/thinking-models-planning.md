# Thinking Models: Planning Cluster

Structured reasoning models for the **planner** and **roadmapper** agents. Apply these at decision points during plan creation, not continuously. Each model counters a specific documented failure mode.

Source: Curated from [thinking-partner](https://github.com/mattnowdev/thinking-partner) model catalog (150+ models). Selected for direct applicability to GSD planning workflow.

## Conflict Resolution

Pre-Mortem and Constraint Analysis both analyze risk at different granularities. Run Constraint Analysis FIRST (identify the hardest constraint), then Pre-Mortem (enumerate failure modes around that constraint and the rest of the plan).

## 1. Pre-Mortem Analysis

**Counters:** Optimistic plan decomposition that ignores failure modes.

Before finalizing this plan, assume it has already failed. List the 3 most likely reasons for failure -- missing dependency, wrong decomposition, underestimated complexity -- and add mitigation steps or acceptance criteria that would catch each failure early.

## 2. MECE Decomposition

**Counters:** Overlapping tasks (merge conflicts) or gapped tasks (missing requirements).

Verify this task breakdown is MECE at the REQUIREMENT level: (1) list every requirement from the phase goal, (2) confirm each maps to exactly one task's `<done>`, (3) if two tasks modify the same file, confirm they modify DIFFERENT sections or serve DIFFERENT requirements, (4) flag any requirement not covered by any task.

## 3. Constraint Analysis

**Counters:** Deferring the hardest constraint to the last task, causing late-stage failures.

Identify the single hardest constraint in this phase -- the one thing that, if it doesn't work, makes everything else irrelevant. Schedule that constraint as Task 1 or 2, not last. If the constraint involves an external API or unfamiliar library, add a spike/proof-of-concept task before the main implementation.

## 4. Reversibility Test

**Counters:** Over-analyzing cheap decisions, under-analyzing costly ones.

For each significant decision in this plan, ask what undoing it would cost three phases from now, and rate it `reversible` (local and cheap to change), `costly` (undo touches many call sites or needs a coordinated change), or `one-way` (undo requires a migration, breaks a published contract, or is impossible). Spend analysis time proportional to the rating. Record the rating and a one-line rationale on the task that implements the decision, via `<reversibility>`; a `one-way` rating also earns a `checkpoint:decision` before that task. When unsure, rate it `reversible` — rating everything `one-way` is checkpoint fatigue, not diligence.

This is the reasoning step that produces the rating. The taxonomy itself, the emission rules, and the anti-patterns live in @~/.claude/gsd-core/references/planner-reversibility.md — do not maintain a second classification here.

## 5. Occam's Razor

**Counters:** Plans that prescribe avoidable dependencies, abstractions, files, or speculative flexibility before execution begins.

This check complements the planner's RESEARCH.md `dont_hand_roll` guidance and the plan checker's Dimension 12 (Pattern Compliance): those sources identify capabilities and established patterns, while this check orders otherwise sufficient implementation choices. The executor applies the related check later in `thinking-models-execution.md`, after the plan has already selected an approach.

After preserving locked user decisions and complete requirement coverage, choose the first option that is demonstrably sufficient for the task's `<done>` condition:

1. Existing project behavior, helper, or established pattern
2. Standard-library capability
3. Native platform capability
4. Already-installed dependency
5. Minimum new implementation

This ordering is a sufficiency check, not permission to make the task smaller. It must never reduce requested scope or override locked user decisions, requirement coverage, security, validation, accessibility, error handling, or verification. The planner uses it when choosing implementation actions; the plan checker flags a new abstraction or dependency only when a higher rung is demonstrably sufficient.

## 6. Curse of Knowledge Counter

**Counters:** Plan-to-executor ambiguity from compressed instructions.

For each `<action>` step, re-read it as if you have NEVER seen this codebase. Is every noun unambiguous (which file? which function? which endpoint?)? Is every verb specific (add WHERE? modify HOW?)? If a step could be interpreted two ways, rewrite it. Include file paths, function names, and expected behavior in every action step.

## 7. Base Rate Neglect Counter

**Counters:** Planners ignoring low-confidence research caveats.

Before finalizing the plan, read ALL `[NEEDS DECISION]` items and LOW-confidence recommendations from SUMMARY.md. For each: either (a) create a `checkpoint:decision` task to resolve it, or (b) document why the risk is acceptable in the plan's deviation notes. LOW-confidence items that are silently accepted become undocumented technical debt.

## Gap Closure Mode: Root-Cause Check

**Applies only when:** Planner enters gap closure mode (triggered by `gaps_found` in VERIFICATION.md).

Before writing the fix plan, apply a single "why" round: Why did this gap occur? Was it a plan deficiency (wrong task), an execution miss (correct task, wrong implementation), or a changed assumption (environment/dependency shift)? The fix plan must target the root cause category, not just the symptom.

---

## When NOT to Think

Skip structured reasoning models when the situation does not benefit from them:

- **Single-task plans** -- If the phase has one clear requirement and one obvious task, do not run Pre-Mortem or MECE analysis. Write the task directly.
- **Well-researched phases** -- If RESEARCH.md has HIGH-confidence recommendations for every decision and no `[NEEDS DECISION]` items, skip Base Rate Neglect Counter. The research already resolved uncertainty.
- **Revision iterations** -- When revising a plan based on checker feedback, focus on fixing the flagged issues. Do not re-run the full model suite on every revision pass -- apply only the model relevant to the specific issue (e.g., MECE if the checker found a coverage gap).
- **Boilerplate plans** -- Configuration changes, version bumps, documentation updates. These do not have failure modes worth pre-mortem analysis.

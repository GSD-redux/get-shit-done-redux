# Planner Guidance: Philosophy, Task Calibration, and Output Formats

## Solo Developer + Claude Workflow

Planning for ONE person (the user) and ONE implementer (Claude).
- No teams, stakeholders, ceremonies, coordination overhead
- User = visionary/product owner, Claude = builder
- Estimate effort in context window cost, not time

## Plans Are Prompts

PLAN.md IS the prompt (not a document that becomes one). Contains:
- Objective (what and why)
- Context (@file references)
- Tasks (with verification criteria)
- Success criteria (measurable)

## Quality Degradation Curve

| Context Usage | Quality | Claude's State |
|---------------|---------|----------------|
| 0-30% | PEAK | Thorough, comprehensive |
| 30-50% | GOOD | Confident, solid work |
| 50-70% | DEGRADING | Efficiency mode begins |
| 70%+ | POOR | Rushed, minimal |

**Rule:** Plans should complete within ~50% context. More plans, smaller scope, consistent quality. Each plan: 2-3 tasks max.

## Ship Fast

Plan -> Execute -> Ship -> Learn -> Repeat

**Anti-enterprise patterns (delete if seen):** team structures, RACI matrices, sprint ceremonies, time estimates in human units, complexity/difficulty as scope justification, documentation for documentation's sake.

---

## Task Types

| Type | Use For | Autonomy |
|------|---------|----------|
| `auto` | Everything Claude can do independently | Fully autonomous |
| `checkpoint:human-verify` | Visual/functional verification | Pauses for user |
| `checkpoint:decision` | Implementation choices | Pauses for user |
| `checkpoint:human-action` | Truly unavoidable manual steps (rare) | Pauses for user |

**Automation-first rule:** If Claude CAN do it via CLI/API, Claude MUST do it. Checkpoints verify AFTER automation, not replace it.

## Task Sizing

Each task targets **10–30% context consumption**.

| Context Cost | Action |
|--------------|--------|
| < 10% context | Too small — combine with a related task |
| 10-30% context | Right size — proceed |
| > 30% context | Too large — split into two tasks |

**Context cost signals (use these, not time estimates):**
- Files modified: 0-3 = ~10-15%, 4-6 = ~20-30%, 7+ = ~40%+ (split)
- New subsystem: ~25-35%
- Migration + data transform: ~30-40%
- Pure config/wiring: ~5-10%

**Too large signals:** Touches >3-5 files, multiple distinct chunks, action section >1 paragraph.

**Combine signals:** One task sets up for the next, separate tasks touch same file, neither meaningful alone.

## Interface-First Task Ordering

When a plan creates new interfaces consumed by subsequent tasks:

1. **First task: Define contracts** — Create type files, interfaces, exports
2. **Middle tasks: Implement** — Build against the defined contracts
3. **Last task: Wire** — Connect implementations to consumers

This prevents the "scavenger hunt" anti-pattern where executors explore the codebase to understand contracts. They receive the contracts in the plan itself.

## Specificity

**Test:** Could a different Claude instance execute without asking clarifying questions? If not, add specificity. See @~/.claude/gsd-core/references/planner-antipatterns.md for vague-vs-specific comparison table.

## User Setup Detection

For tasks involving external services, identify human-required configuration:

External service indicators: New SDK (`stripe`, `@sendgrid/mail`, `twilio`, `openai`), webhook handlers, OAuth integration, `process.env.SERVICE_*` patterns.

For each external service, determine:
1. **Env vars needed** — What secrets from dashboards?
2. **Account setup** — Does user need to create an account?
3. **Dashboard config** — What must be configured in external UI?

Record in `user_setup` frontmatter. Only include what Claude literally cannot do. Do NOT surface in planning output — execute-plan handles presentation.

---

## Building the Dependency Graph

**For each task, record:**
- `needs`: What must exist before this runs
- `creates`: What this produces
- `has_checkpoint`: Requires user interaction?

**Example:** A→C, B→D, C+D→E, E→F(checkpoint). Waves: {A,B} → {C,D} → {E} → {F}.

**Prefer vertical slices** (User feature: model+API+UI) over horizontal layers (all models → all APIs → all UIs). Vertical = parallel. Horizontal = sequential. Use horizontal only when shared foundation is required.

## File Ownership for Parallel Execution

Exclusive file ownership prevents conflicts:

```yaml
# Plan 01 frontmatter
files_modified: [src/models/user.ts, src/api/users.ts]

# Plan 02 frontmatter (no overlap = parallel)
files_modified: [src/models/product.ts, src/api/products.ts]
```

No overlap → can run parallel. File in multiple plans → later plan depends on earlier.

---

## Granularity Calibration

The resolved granularity is provided in the planning context as `**Granularity:** <value>`. Read that value and apply the corresponding row below. When no explicit value is present, default to Standard.

| Granularity | Typical Plans/Phase | Tasks/Plan |
|-------------|---------------------|------------|
| Coarse | 1-3 | 2-3 |
| Standard | 3-5 | 2-3 |
| Fine | 5-10 | 2-3 |

Derive plans from actual work. Granularity determines compression tolerance, not a target.

---

## Planning Complete Return Format

```markdown
## PLANNING COMPLETE

**Phase:** {phase-name}
**Plans:** {N} plan(s) in {M} wave(s)

### Wave Structure

| Wave | Plans | Autonomous |
|------|-------|------------|
| 1 | {plan-01}, {plan-02} | yes, yes |
| 2 | {plan-03} | no (has checkpoint) |

### Plans Created

| Plan | Objective | Tasks | Files |
|------|-----------|-------|-------|
| {phase}-01 | [brief] | 2 | [files] |
| {phase}-02 | [brief] | 3 | [files] |

### Next Steps

Run `/clear` first for a fresh context window, then execute: `/gsd:execute-phase {phase}`
```

## Gap Closure Plans Created Return Format

```markdown
## GAP CLOSURE PLANS CREATED

**Phase:** {phase-name}
**Closing:** {N} gaps from {VERIFICATION|UAT}.md

### Plans

| Plan | Gaps Addressed | Files |
|------|----------------|-------|
| {phase}-04 | [gap truths] | [files] |

### Next Steps

Execute: `/gsd:execute-phase {phase} --gaps-only`
```

## Checkpoint Reached / Revision Complete

Follow templates in checkpoints and revision_mode sections respectively.

---

## Goal-Backward Worked Example

### Step 2: Derive Observable Truths

For "working chat interface":
- User can see existing messages
- User can type a new message
- User can send the message
- Sent message appears in the list
- Messages persist across page refresh

**Test:** Each truth verifiable by a human using the application.

### Step 3: Derive Required Artifacts

"User can see existing messages" requires:
- Message list component (renders Message[])
- Messages state (loaded from somewhere)
- API route or data source (provides messages)
- Message type definition (shapes the data)

**Test:** Each artifact = a specific file or database object.

### Step 4: Derive Required Wiring

Message list component wiring:
- Imports Message type (not using `any`)
- Receives messages prop or fetches from API
- Maps over messages to render (not hardcoded)
- Handles empty state (not just crashes)

### Step 5: Identify Key Links

"Where is this most likely to break?" Key links = critical connections where breakage causes cascading failures.

### Must-Haves Output Format

```yaml
must_haves:
  truths:
    - "User can see existing messages"
    - "User can send a message"
    - "Messages persist across refresh"
  artifacts:
    - path: "src/components/Chat.tsx"
      provides: "Message list rendering"
      min_lines: 30
    - path: "src/app/api/chat/route.ts"
      provides: "Message CRUD operations"
      exports: ["GET", "POST"]
    - path: "prisma/schema.prisma"
      provides: "Message model"
      contains: "model Message"
  key_links:
    - from: "src/components/Chat.tsx"
      to: "src/app/api/chat/route.ts"
      via: "fetch in useEffect — calls /api/chat endpoint"
      pattern: "fetch.*api/chat"
    - from: "src/app/api/chat/route.ts"
      to: "prisma/schema.prisma"
      via: "database query via prisma.message"
      pattern: "prisma\\.message\\.(find|create)"
```

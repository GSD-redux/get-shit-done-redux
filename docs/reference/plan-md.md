# PLAN.md schema reference

A per-plan `PLAN.md` is GSD Core's executable unit of work — a structured document that tells an executor agent exactly what to build and how to verify it was built correctly. This page documents its structure. See [docs index](../README.md).

---

## Overview

Plans live inside phase directories at:

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-PLAN.md
```

For example: `.planning/phases/03-post-feed/03-02-PLAN.md` (Phase 3, Plan 2).

Plans are produced by the `gsd-planner` agent (spawned by `/gsd:plan-phase`) and consumed by `execute-phase`. A phase typically contains between one and four plans; plans within a phase are assigned to execution waves so that independent work runs in parallel.

---

## YAML frontmatter

Every PLAN.md opens with a YAML frontmatter block between `---` delimiters.

### Annotated example

```yaml
---
phase: 03-post-feed
plan: 02
type: execute
wave: 2
depends_on: ["03-01"]
files_modified:
  - src/components/PostFeed.tsx
  - src/components/PostCard.tsx
  - src/app/feed/page.tsx
autonomous: true
requirements: ["FEED-01", "FEED-03"]
user_setup: []

must_haves:
  truths:
    - "User can scroll through posts from followed accounts"
    - "Each post shows author avatar, name, timestamp, and content"
    - "Empty state appears when no posts exist"
  artifacts:
    - path: "src/components/PostFeed.tsx"
      provides: "Scrollable post list"
      min_lines: 40
    - path: "src/components/PostCard.tsx"
      provides: "Individual post card"
      exports: ["PostCard"]
  key_links:
    - from: "src/components/PostFeed.tsx"
      to: "src/app/api/feed/route.ts"
      via: "fetch in useEffect — calls /api/feed endpoint"
      pattern: "fetch.*api/feed"
---
```

### Frontmatter field reference

| Field | Required | Type | Purpose |
|---|---|---|---|
| `phase` | Yes | string | Phase identifier, e.g. `03-post-feed`. |
| `plan` | Yes | string | Plan number within the phase, e.g. `02`. |
| `type` | Yes | `execute` or `tdd` | `execute` for standard plans; `tdd` for test-driven plans where tests are written before implementation. |
| `wave` | Yes | integer | Execution wave. Plans in wave 1 run in parallel (no dependencies). Plans in wave 2+ wait for all plans in the previous wave to complete. Pre-computed at plan time by `gsd-planner`. |
| `depends_on` | Yes | array of plan IDs | Plans this plan must wait for. Empty array = wave 1. Example: `["03-01"]` means this plan runs after Plan 01 in Phase 3. |
| `files_modified` | Yes | array of paths | Every file this plan creates or modifies. Used by the plan-checker to detect same-wave file conflicts and by execute-phase for merge tracking. |
| `autonomous` | Yes | boolean | `true` when all tasks are type `auto`. `false` when the plan contains any `checkpoint:*` task that requires human interaction. |
| `requirements` | Yes | array of IDs | Requirement IDs from ROADMAP.md that this plan addresses. Every phase requirement ID must appear in at least one plan's `requirements` field. Empty arrays are a BLOCKER. |
| `user_setup` | No | array of objects | External-service setup steps that Claude cannot automate (account creation, secret retrieval, dashboard configuration). When present, execute-phase generates a `USER-SETUP.md` checklist for the developer. |
| `status` | No | `superseded` | Marks a plan that was deliberately reassigned or abandoned mid-phase and will never be executed. A `status: superseded` plan is excluded from the phase's plan and summary counts, so it never holds the phase below 100%. See [Superseded plans](#superseded-plans). Any other value (or the field's absence) has no effect on counting. |
| `estimate` | No | object | Projected execution cost: `{tokens, tasks, confidence}` (#2631, [ADR-2629](../adr/2629-phase-effort-estimation-calibration.md)). `tokens` is an `estimateTokens`-scale projection with the project's calibration factor **already applied** (which is why the plan-checker passes `--calibrated` to `estimate-check` — re-applying it would square the correction); `confidence` (`low`/`med`/`high`) is **derived from the calibration sample count, never self-rated**. Additive and optional — a plan without it behaves exactly as before. A plan estimated above `workflow.smart_zone_tokens` is flagged with a split recommendation at plan time; the flag is advisory and never blocks. |
| `must_haves` | Yes | object | Goal-backward verification criteria. See below. |

### Superseded plans

A phase reads complete when every `*-PLAN.md` has a matching `*-SUMMARY.md`. When a plan is reassigned or dropped mid-phase — its work folded into a later plan — it will never gain a summary, and without a marker it would pin the phase below 100% forever (the plan-level analogue of a retired phase). Add `status: superseded` to that plan's frontmatter to exclude it from **both** the plan count (denominator) and the summary count (numerator):

```yaml
---
phase: 05-api
plan: "12"
type: execute
status: superseded
---
```

A phase with 13 plans, two of them `superseded`, then reads `11/11 → complete` — no fabricated summary required. The match is case-insensitive. Plans without the marker are counted exactly as before.

---

## `must_haves` field

`must_haves` captures what must be observably true for the phase goal to be achieved. It is derived during planning and verified after execution by the `gsd-verifier` agent.

### Sub-fields

| Sub-field | Type | Purpose |
|---|---|---|
| `truths` | array of strings | Observable behaviours from the user's perspective. Each must be verifiable. Example: `"User can send a message"`, not `"WebSocket library installed"`. |
| `artifacts` | array of objects | Files that must exist with substantive implementation (not stubs). |
| `artifacts[].path` | string | File path relative to project root. |
| `artifacts[].provides` | string | What capability this file delivers. |
| `artifacts[].min_lines` | integer (optional) | Minimum line count to be considered non-stub. |
| `artifacts[].exports` | array of strings (optional) | Expected named exports to verify. |
| `artifacts[].contains` | string (optional) | Regex or literal pattern that must appear in the file. |
| `key_links` | array of objects | Critical connections between artifacts — the wiring that makes the system work end-to-end. |
| `key_links[].from` | string | Source file (relative path from project root). Must be a literal file path — describe components or symbols in `via:`. |
| `key_links[].to` | string | Target file (relative path from project root). Must be a literal file path — describe endpoints, modules, or APIs in `via:`. |
| `key_links[].via` | string | Description of how they connect, including any endpoint, component, or symbol name (e.g. `fetch in useEffect — calls /api/feed`, `Prisma query via prisma.message`, `import`). |
| `key_links[].pattern` | string (optional) | Regex to verify the connection exists in source. |

---

## Body structure

After frontmatter, the plan body uses named XML-style blocks read by the executor agent.

### `<objective>`

States what the plan delivers and why it matters for the project:

```xml
<objective>
Implement the post feed as a scrollable card list.

Purpose: Core display feature for the social feed phase.
Output: PostFeed and PostCard components wired to /api/feed.
</objective>
```

### `<execution_context>`

Lists the workflow files associated with executing the plan. Always includes the execute-plan workflow; adds the checkpoints reference when the plan contains checkpoint tasks:

```xml
<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>
```

These `@` paths point at the local GSD install, not at repository files. The prefix shown here (`~/.claude/gsd-core/…`) is the Claude global-install location; other runtimes and local installs resolve to their own install directory — for example `.cursor/gsd-core/…`, or an absolute project path for a `--local` install. Because the prefix is install-relative, this block is not clone-portable: a committed plan carries whichever prefix the authoring install had. Execution does not depend on it — `/gsd-execute-phase` loads the execute-plan workflow from its own installed copy — so the block records the execution context rather than resolvable repository references. Contrast `<context>` (below), whose repository-relative `@` paths resolve after a `git clone`.

### `<context>`

References source files the executor needs to read. Includes project-level planning docs and any source files whose patterns or types the plan must replicate. Prior plan `SUMMARY.md` files are included only when there is a genuine dependency (imported types, shared decision) — not reflexively:

```xml
<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@src/components/UserCard.tsx
</context>
```

### `<tasks>`

Contains one or more `<task>` elements. Every task element must carry `<name>`, `<files>`, `<read_first>`, `<action>`, `<verify>`, `<acceptance_criteria>`, and `<done>` for `type="auto"` and `type="tracer"` tasks. Optional `<precondition>` (see [Preconditions](#preconditions)) and `<reversibility>` (see [Reversibility](#reversibility)) elements may sit between `<name>` and `<files>`.

---

## Preconditions

`<precondition>` is an **optional** element on `<task>` (issue #1949, *The Pragmatic Programmer* Topic 23 — Design by Contract). It states, in a single line of runnable/checkable prose, what must already be true for the task to begin safely. It closes the front-of-task side of the contract triad — preconditions (before) ↔ postconditions (`<verify>`/`<done>`/`<acceptance_criteria>`, after) ↔ invariants (`must_haves.truths`, across the whole plan).

```xml
<task type="auto">
  <name>Add /reveal endpoint handler</name>
  <precondition>server bootstraps and responds to GET /health (from the tracer slice)</precondition>
  <files>server/reveal.ts</files>
  <action>…</action>
  <verify>curl /reveal?path=… opens the OS file manager</verify>
  <done>Endpoint committed and manually verified</done>
</task>
```

**Optional and back-compat:** a plan that omits `<precondition>` on every task behaves exactly as today — the executor skips the check with no visible change. Adding `<precondition>` to a task tells the executor to assert it before any other task work (read-only checks only: file existence, env var presence, idempotent health pings; no side-effecting checks — halt and surface a checkpoint if one seems required) and halt (returning a `checkpoint:human-verify`, no partial commit) on an unmet precondition. Plans that include `<precondition>` pass `verify plan-structure` unchanged — the structural validator checks for the presence of required tags and does not reject unknown optional tags.

**Emission cases** (planner-side): emit `<precondition>` only when a task relies on state the plan's own `depends_on` ordering does not already guarantee. Three cases cover every legitimate use:

1. **External service setup** (`user_setup` frontmatter) — the consuming task ties a specific setup step to itself so the executor halts if the setup was skipped.
2. **Prior-phase artifact dependency** — a generated schema, a migration's dist output, a contract file from an earlier phase. Cross-phase `depends_on` does not cross phase boundaries, so `<precondition>` is the explicit pointer.
3. **Environment variable / runtime configuration** — a tool, API, or script the task invokes requires an env var or runtime config that exists *now*, not at plan time.

Full emission rules, anti-patterns ("the system is ready" is not checkable; do not use `<precondition>` for intra-plan sequencing — that is what `depends_on` is for), and the contract triad mapping: see `gsd-core/references/planner-preconditions.md`.

---

## Reversibility

`<reversibility>` is an **optional** element on `<task>` (issue #1951, *The Pragmatic Programmer* Topic 15 — "Reversibility"). It records how costly the decision the task implements would be to undo, so a one-way-door choice gets a human beat before the agent walks through it. The `rating` attribute carries the classification; the body carries a one-line rationale.

```xml
<task type="auto">
  <name>Define the on-disk event log format</name>
  <reversibility rating="one-way">Phases 4-6 read this file; changing the
  format after they land requires a migration for every existing project.</reversibility>
  <files>src/event-log.cts</files>
  <action>…</action>
  <verify><automated>npm run test:unit -- event-log</automated></verify>
  <done>Format documented and written by the writer under test</done>
</task>
```

| Rating | Meaning | Effect on the plan |
|---|---|---|
| `reversible` | Undo is local and cheap. | None. This is the default when no rating is given. |
| `costly` | Undo touches many call sites or needs a coordinated change. | Flagged in the plan so the reader sees the weight. Never blocks. |
| `one-way` | Undo requires a migration, breaks a published contract, or is impossible. | The planner inserts a `checkpoint:decision` immediately **before** the dependent task. |

**Optional and back-compat:** a plan that omits `<reversibility>` on every task behaves exactly as today — no flag, no checkpoint. Plans that include it pass `verify plan-structure` unchanged; the structural validator checks for the presence of required tags and does not reject unknown optional tags.

**Autonomy:** inserting a `checkpoint:decision` means the plan contains a checkpoint, so its frontmatter must set `autonomous: false`.

**Override:** `/gsd:plan-phase --no-reversibility-gates` (`REVERSIBILITY_GATES=false`) suppresses checkpoint insertion for intentionally-unattended runs. Ratings are still recorded and `costly` items are still flagged — the override changes what stops the run, not what the plan remembers.

Full taxonomy, emission rules, and anti-patterns (chiefly: rating everything `one-way` produces checkpoint fatigue; prefer *removing* irreversibility over gating it): see `gsd-core/references/planner-reversibility.md`.

---

## Task types

| Type | Use | Autonomy |
|---|---|---|
| `auto` | Everything the executor can do independently. | Fully autonomous. |
| `tracer` | The leading thin end-to-end slice a plan starts with by default (tracer-first) — production-quality, wired through every layer, with a real end-to-end `<verify>`. | Fully autonomous; after committing, the executor runs the tracer's `<verify>` as an early integration gate — autonomous runs halt on failure before expansion, interactive runs present a `checkpoint:human-verify`. |
| `checkpoint:human-verify` | Visual or functional verification that requires a human to look at a running UI or service. | Pauses execution; presents to the developer; resumes on approval. |
| `checkpoint:decision` | Implementation choices that arose during execution and require the developer's input. | Pauses execution; presents options; resumes on selection. |
| `checkpoint:human-action` | Truly unavoidable manual steps (account creation, hardware interaction). Used sparingly. | Pauses execution; resumes on confirmation. |

Plans that contain any checkpoint task must set `autonomous: false` in frontmatter.

---

## `auto` task structure

```xml
<task type="auto">
  <name>Task 1: Create PostCard component</name>
  <files>src/components/PostCard.tsx</files>
  <read_first>src/components/UserCard.tsx, src/types/post.ts</read_first>
  <action>Create PostCard component accepting a Post prop (id, authorId, content, createdAt,
    reactionCount). Render author avatar using UserAvatar from UserCard pattern. Show timestamp
    using date-fns formatDistanceToNow. Export as named export PostCard.</action>
  <verify>npx tsc --noEmit</verify>
  <acceptance_criteria>
    - src/components/PostCard.tsx exports named export PostCard
    - PostCard.tsx contains "reactionCount" prop usage
    - npx tsc --noEmit exits 0
  </acceptance_criteria>
  <done>PostCard renders post content with author and timestamp</done>
</task>
```

### Required fields for `auto` tasks

| Field | Rule |
|---|---|
| `<files>` | Every file the task creates or modifies. The executor writes only these files. |
| `<read_first>` | Files the executor must read before touching anything — the file being modified, any source-of-truth pattern file, any file whose types or conventions must be replicated. |
| `<action>` | Concrete instructions with exact identifiers, file paths, function signatures, and expected values. Never says "align X with Y" without specifying the target state. Never contains fenced code blocks or full implementations. |
| `<verify>` | A runnable command or check that proves the task succeeded. Must distinguish pass from fail — `echo "done"` is not valid. |
| `<acceptance_criteria>` | Verifiable conditions: grep-verifiable strings, command exit codes, observable behaviours. No subjective language ("looks correct", "properly configured"). Negative greps (`! grep -Eq 'PAT' file`) are file-scoped — region-scope them (`sed -n`/`awk` range, then grep) when a sibling task needs the construct elsewhere in the same file (#968). |
| `<done>` | A short measurable statement of the completed outcome. |

---

## Plan quality dimensions

The `gsd-plan-checker` agent reviews every PLAN.md across 12 dimensions before execution begins. A plan that fails any BLOCKER-severity check is returned to `gsd-planner` for revision (up to 3 iterations):

| Dimension | What it checks |
|---|---|
| **1 — Requirement Coverage** | Every phase requirement ID from ROADMAP.md appears in at least one plan's `requirements` frontmatter field and has covering task(s). |
| **2 — Task Completeness** | Every `auto` task carries all required fields (`<files>`, `<action>`, `<verify>`, `<acceptance_criteria>`, `<done>`). No vague or empty fields. |
| **3 — Dependency Correctness** | `depends_on` references are valid, acyclic, and consistent with wave numbers. Wave N plan depends only on plans in waves < N. |
| **4 — Key Links Planned** | Artifacts in `must_haves.key_links` have corresponding tasks that implement the wiring — not just the artifact creation. |
| **5 — Scope Sanity** | Plans stay within context budget: 2–3 tasks per plan (4 = warning, 5+ = BLOCKER), ≤ 8–10 files per plan (15+ = BLOCKER). |
| **6 — Verification Derivation** | `must_haves.truths` are user-observable behaviours, not implementation details. Artifacts map to truths. Key links cover critical wiring. |
| **7 — Context Compliance** | Every `D-NN` decision from CONTEXT.md is addressed by at least one task. No task implements anything from `<deferred>`. |
| **7b — Scope Reduction Detection** | Task actions do not silently reduce a locked decision to a "v1", "stub", or "future enhancement" without delivering the full decision scope. Always a BLOCKER when found. |
| **7c — Architectural Tier Compliance** | Tasks assign capabilities to the correct tier per the RESEARCH.md Architectural Responsibility Map (when present). Security-sensitive capabilities in the wrong tier are BLOCKERs. |
| **8 — Nyquist Compliance** | When `workflow.nyquist_validation` is enabled and RESEARCH.md exists, every task has an `<automated>` verify command, no consecutive window of 3 tasks lacks coverage, and VALIDATION.md is present. |
| **9 — Cross-Plan Data Contracts** | When plans share data pipelines, their transformations are compatible — no plan strips data that another plan needs in original form. |
| **10 — CLAUDE.md Compliance** | Plans respect project-specific conventions, forbidden patterns, required tools, and security requirements from `./CLAUDE.md`. |
| **11 — Research Resolution** | When RESEARCH.md exists, its `## Open Questions` section is marked `(RESOLVED)` before planning proceeds. |
| **12 — Pattern Compliance** | When PATTERNS.md exists, tasks reference the correct analog patterns for each new or modified file. |

---

## Wave execution model

Wave numbers are pre-computed during planning. Execute-phase groups plans by wave number and runs each wave's plans in parallel:

```
Wave 1: Plan 01, Plan 02, Plan 03  (all run simultaneously — no dependencies)
Wave 2: Plan 04                    (waits for Wave 1 to complete)
Wave 3: Plan 05                    (waits for Wave 2 to complete)
```

Plans within a wave that modify overlapping files must not be in the same wave — the plan-checker's Dimension 3 flags this as a BLOCKER.

---

## Plan output

After a plan executes successfully, the executor writes a SUMMARY.md at:

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-SUMMARY.md
```

The SUMMARY.md is the canonical record of what was built. Subsequent plans in the same phase may reference it when they have a genuine dependency on its types or decisions.

---

## Related

- [CONTEXT.md schema](context-md.md)
- [Planning artifacts](planning-artifacts.md)
- [Features](../FEATURES.md)
- [docs index](../README.md)

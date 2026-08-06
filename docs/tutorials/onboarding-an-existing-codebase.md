# Onboarding an existing codebase

In this tutorial you will bring GSD Core into a repository that already has code in it. You will map the codebase, create a project that describes what you are *adding*, and run your first discuss-and-plan cycle for a small focused change. By the end, GSD Core's planning pipeline will know your stack, your conventions, and your concerns — and it will use that knowledge every time you plan.

---

## What you'll build

We will add a single `GET /health` endpoint to an existing Express application. The change is small enough that it will never distract from the real lesson: how GSD Core learns your codebase before it plans anything.

---

## Prerequisites

- **Node.js 18 or later** — `node --version` should print `v18.x.x` or higher.
- **An existing project** — any repo with code already in it. It does not have to be Express; the steps apply to any stack.
- **Claude Code** — open in your repo root.

---

## Step 1 — Install GSD Core

From your repo root:

```bash
npx @opengsd/gsd-core@latest
```

Choose **Claude Code** and **local** when prompted. You'll see:

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

---

## Step 2 — Start Claude Code with permissions

```bash
claude --dangerously-skip-permissions
```

> [!CAUTION]
> **The permissions flag is optional.** It skips per-file confirmation while
> GSD's sub-agents read and write files. Use it only in low-stakes or
> throwaway contexts. To keep confirmations enabled, start with `claude` instead.
> For real work, read the [security model](../explanation/security-model.md) first.


---

## Step 3 — Start brownfield onboarding

Before creating a project, let GSD Core inspect the repo state and tell you the safe next top-level command. This is the step that prevents brownfield setup from skipping codebase context or overwriting existing planning files.

```text
/gsd-onboard
```

If code exists and `.planning/codebase/` is missing, GSD Core asks you to map the codebase first. Choose the recommended mapping option, then run the printed handoff command:

```text
/gsd-map-codebase
```

Use `/gsd-onboard --fast` if you want the onboarding gate to prefer `/gsd-map-codebase --fast` for a lighter first pass. Fast mode is only enough for lightweight onboarding; `/gsd-onboard` still sends you back to the full mapper before `/gsd-new-project`. The full mapper spawns four parallel mapper sub-agents (you'll see "Spawning 4 parallel codebase mapper agents…" — this takes 1–5 minutes; do not interrupt). Each agent focuses on a different concern:

| Agent | Focus |
|-------|-------|
| Tech mapper | Stack, frameworks, dependencies |
| Architecture mapper | Patterns, layers, data flow |
| Quality mapper | Conventions, testing practices |
| Concerns mapper | Technical debt, risk areas |

When all four return, you'll see:

```text
Codebase mapping complete.

Created .planning/codebase/:
- STACK.md        (47 lines) - Technologies and dependencies
- ARCHITECTURE.md (62 lines) - System design and patterns
- STRUCTURE.md    (38 lines) - Directory layout and organisation
- CONVENTIONS.md  (55 lines) - Code style and patterns
- TESTING.md      (41 lines) - Test structure and practices
- INTEGRATIONS.md (29 lines) - External services and APIs
- CONCERNS.md     (33 lines) - Technical debt and issues
```

Open `.planning/codebase/STACK.md`. You'll see the language, runtime, framework versions, and key dependencies GSD Core detected — grounded in the actual files it read, not guessed.

Open `.planning/codebase/CONVENTIONS.md`. You'll see the naming conventions, error-handling patterns, and code-style rules it observed from your source. Every plan GSD Core produces for this repo will follow these conventions automatically.

Open `.planning/codebase/CONCERNS.md`. This is the most useful file to read before any new feature work — it surfaces technical debt and fragile areas that might affect your plans.

---

## Step 4 — Rerun onboarding and initialize the project

Clear the session window:

```text
/clear
```

Now rerun onboarding:

```text
/gsd-onboard
```

If GSD Core detects ADRs, PRDs, specs, RFCs, or top-level requirements docs, choose the recommended docs-ingest handoff first and rerun `/gsd-onboard` afterward. Once codebase context and any existing docs are handled, onboarding prints the project-initialization handoff:

```text
/gsd-new-project
```

Because GSD Core found existing code in the previous step, `/gsd-new-project` knows this is a brownfield project. The questions focus on what you are *adding*, not rebuilding what already exists:

GSD Core asks what you want to build. Answer with the feature you are adding, not a description of the whole codebase:

```text
Add a GET /health endpoint to the Express app. It should return
{ "status": "ok", "uptime": <seconds> }. We'll use it for load-balancer
health checks.
```

GSD Core follows up with a small number of clarifying questions, then proceeds to requirements and roadmap creation. Because it already read `ARCHITECTURE.md` and `STACK.md`, it will map existing capabilities into the **Validated** section of `PROJECT.md` automatically — you do not need to describe your existing API surface.

Choose recommended defaults for all workflow settings.

When the roadmapper sub-agent returns, you'll see a proposed roadmap. For a single small change it will be one phase:

```text
Proposed Roadmap

1 phase | 2 requirements mapped | All v1 requirements covered ✓

| # | Phase          | Goal                                          | Requirements |
|---|----------------|-----------------------------------------------|--------------|
| 1 | Health endpoint| GET /health returning status and uptime JSON  | HLT-01, HLT-02 |
```

Approve the roadmap.

**What gets created in `.planning/`:**

```text
.planning/
  PROJECT.md          ← project description; existing capabilities in "Validated"
  REQUIREMENTS.md     ← HLT-01, HLT-02
  ROADMAP.md          ← Phase 1, status: pending
  STATE.md            ← session memory
  config.json         ← workflow settings
  codebase/           ← the seven map files from Step 3
```

Notice that `.planning/codebase/` is already there from Step 3. GSD Core read those files when writing `PROJECT.md`, which is why it could populate the Validated requirements without you describing them.

Run onboarding one more time after project setup completes:

```text
/gsd-onboard
```

Now that `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, and `STATE.md` all exist, onboarding creates or confirms:

```text
.planning/onboarding/SUMMARY.md
```

This summary is a lightweight index of the setup artifacts and the next command to run.

---

## Step 5 — Clear context and discuss Phase 1

```text
/clear
```

```text
/gsd-discuss-phase 1
```

Because GSD Core has read your `CONVENTIONS.md` and `ARCHITECTURE.md`, its questions are grounded in your actual codebase — not generic advice. You might see:

```text
> Your routes are registered in src/routes/index.js. Should the health
  endpoint live there, or in a dedicated src/routes/health.js?
  A dedicated health.js — keep routes separated.

> Your existing error middleware returns { error: "message" }. Should
  /health use the same shape for error responses?
  Yes, stay consistent.

> Should uptime be calculated from process.uptime() or a stored start time?
  process.uptime() is fine.
```

When the discussion closes, GSD Core writes:

```text
.planning/phases/01-health-endpoint/CONTEXT.md
```

Open that file. The `## Implementation Decisions` section captures your answers. The planner will read this file before writing a single task — so your preferences about file placement and response shape will appear in the plans, not just in the discussion.

---

## Step 6 — Plan Phase 1

```text
/gsd-plan-phase 1
```

Four research sub-agents run in parallel (1–5 minutes). When they return, the planner reads `CONTEXT.md`, the research findings, and your codebase map to create task plans that match your conventions.

**What gets created:**

```text
.planning/phases/01-health-endpoint/
  RESEARCH.md         ← findings on health endpoint patterns
  01-01-PLAN.md       ← Task: create src/routes/health.js
  01-02-PLAN.md       ← Task: register health route in src/routes/index.js
```

Open `01-01-PLAN.md`. Notice that the `<files>` tag references `src/routes/health.js` — the exact path you specified in the discussion, consistent with the routing pattern GSD Core observed in your codebase map. That is the codebase map at work.

---

## What's next

You now have a project with a codebase map, a discuss decision record, and verified task plans — all grounded in your actual code. From here, the workflow is identical to a greenfield project:

```text
/gsd-execute-phase 1
/gsd-verify-work 1
/gsd-ship 1
```

For every future feature, run `/gsd-map-codebase` again whenever the structure changes significantly, so the codebase map stays fresh. Rerun `/gsd-onboard` only when you want to re-check first-time setup completeness or regenerate the onboarding summary.

---

## What you've learned

- How `/gsd-onboard` safely sequences brownfield setup without nesting interactive commands or overwriting existing planning files.
- How `/gsd-map-codebase` runs four parallel agents to produce `STACK.md`, `ARCHITECTURE.md`, `CONVENTIONS.md`, `CONCERNS.md`, `STRUCTURE.md`, `TESTING.md`, and `INTEGRATIONS.md` in `.planning/codebase/`.
- How `/gsd-new-project` in a brownfield repo focuses questions on what you are *adding* and populates Validated requirements from existing code.
- How the codebase map shapes every question in `/gsd-discuss-phase` — file paths, patterns, and conventions come from your actual code.
- How the planner reads `CONTEXT.md` plus `CONVENTIONS.md` to produce plans that match your repo's style.

---

## Related

- [Your first project](your-first-project.md) — the full greenfield loop from install to PR
- [Commands](../COMMANDS.md) — `/gsd-onboard`, plus all `/gsd-map-codebase` flags and subcommands
- [Documentation index](../README.md)

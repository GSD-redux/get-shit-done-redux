# How to design a UI phase

**Goal:** Produce a locked UI design contract (`UI-SPEC.md`) that fixes spacing, color, typography, and copywriting decisions before the planner writes tasks, preventing visual inconsistency caused by ad-hoc styling choices during execution.

**Prerequisites:** `.planning/ROADMAP.md` exists. The phase must have frontend or UI work. Running `/gsd-discuss-phase N` first is strongly recommended — the UI researcher reads `CONTEXT.md` to avoid re-asking decisions you have already made.

---

## Decide whether this phase needs a UI contract

Not all phases need `/gsd-ui-phase`. Use it when:

- The phase introduces new UI surfaces (pages, flows, layouts)
- Multiple components will be built and visual consistency matters
- You are starting a new project's frontend and need a design system baseline
- You are adding significant UI work to an existing project and want to lock tokens, spacing, and color before execution

Skip it when:

- The phase is purely backend, infrastructure, or data work with no user-facing output
- A UI-SPEC.md already exists for an earlier phase and this phase builds on identical visual patterns without introducing new surfaces

If you are unsure, the safety gate will prompt you: when `workflow.ui_safety_gate` is enabled (default), `/gsd-plan-phase` warns when it detects frontend work but no UI-SPEC.md and asks whether to run `/gsd-ui-phase` first.

---

## Run the UI design contract

```bash
/gsd-ui-phase 2
```

If no phase number is given, GSD Core targets the current phase.

The command runs in two stages:

1. **`gsd-ui-researcher`** — reads `CONTEXT.md`, `RESEARCH.md`, and `REQUIREMENTS.md` for existing decisions, detects the design system state (shadcn `components.json`, Tailwind config, existing tokens), and asks only the unanswered design questions across five areas: spacing, color, typography, copywriting, and registry safety.
2. **`gsd-ui-checker`** — validates the resulting `UI-SPEC.md` across six dimensions. If issues are found, a revision loop reruns the researcher (up to two iterations) targeting only the flagged items.

**Output:** `{padded_phase}-UI-SPEC.md` in `.planning/phases/{phase-dir}/`.

---

## What the UI-SPEC covers

The researcher locks decisions across five areas:

| Area | Examples |
|---|---|
| **Spacing** | Base scale (4px or 8px), grid alignment, component padding |
| **Color** | Primary, accent, neutral palette; 60/30/10 rule; dark-mode considerations |
| **Typography** | Font families, size/weight scale constraints, heading hierarchy |
| **Copywriting** | CTA labels, empty state messages, error state copy, loading indicators |
| **Registry safety** | shadcn component inspection protocol (see below) |

The checker validates the spec against six pillars, scored 1–4 each: Copywriting, Visuals, Color, Typography, Spacing, and Experience Design (loading / error / empty state coverage).

---

## shadcn initialization

For React, Next.js, and Vite projects, the researcher offers to initialize shadcn if no `components.json` is found. The flow:

1. Visit `ui.shadcn.com/create` and configure your preset (colors, border radius, fonts)
2. Copy the preset string
3. Run:

```bash
npx shadcn init --preset <paste>
```

The preset string becomes a first-class GSD Core planning artifact that is reproducible across phases and milestones.

---

## Registry safety gate

Third-party shadcn registries can inject arbitrary code. When `workflow.ui_safety_gate` is enabled (default), the spec requires these steps before installing any non-official component:

```bash
npx shadcn view <component>   # inspect source before installing
npx shadcn diff <component>   # compare against the official registry
```

The checker will flag the spec as BLOCKED if registry safety is not addressed. Disable the gate via `/gsd-settings` if your project does not use shadcn or you have an alternative vetting process.

---

## Use sketch findings as a head start

If you have already run `/gsd-sketch --wrap-up`, the UI researcher loads `.claude/skills/sketch-findings-[project]/` automatically. Pre-validated decisions (layout, palette, typography, spacing) are treated as locked — the researcher does not re-ask them. You see a note at the start of the run:

```text
⚡ Sketch findings detected: .claude/skills/sketch-findings-[project]/SKILL.md
   Pre-validated decisions (layout, palette, typography, spacing) should be treated
   as locked — not re-asked.
```

This is the main reason to run `/gsd-sketch --wrap-up` before `/gsd-ui-phase`: it turns the conversational design exploration into binding contract input.

---

## Retroactive visual audit with `/gsd-ui-review`

`/gsd-ui-review` runs after execution, not before. Use it to audit the implemented frontend against the UI-SPEC (or against abstract 6-pillar standards when no spec exists).

```bash
/gsd-ui-review        # audit the current phase
/gsd-ui-review 3      # audit phase 3 specifically
```

It works on any project with frontend code — GSD project initialization is not required.

**What it checks (6 pillars, scored 1–4 each):**

1. Copywriting — CTA labels, empty states, error states
2. Visuals — focal points, visual hierarchy, icon accessibility
3. Color — accent usage discipline, 60/30/10 compliance
4. Typography — font size and weight constraint adherence
5. Spacing — grid alignment, token consistency
6. Experience Design — loading, error, and empty state coverage

**Output:** `{padded_phase}-UI-REVIEW.md` with scores and top three priority fixes. When a browser MCP server such as `gsd-browser` is configured, the audit also captures screenshots with visual evidence.

**Screenshot storage:** Screenshots are saved to `.planning/ui-reviews/`. A `.gitignore` is created automatically to prevent binary files from reaching git. Screenshots are cleaned up during `/gsd-complete-milestone`.

---

## Recommended position in the phase lifecycle

```text
/gsd-discuss-phase N      ← lock implementation preferences
/gsd-ui-phase N           ← lock design contract (frontend phases)
/gsd-plan-phase N         ← research + plan (reads UI-SPEC.md as context)
/gsd-execute-phase N      ← parallel execution
/gsd-verify-work N        ← manual UAT
/gsd-ui-review N          ← retroactive visual audit (optional but recommended)
```

`/gsd-ui-phase` sits between discuss and plan because the planner reads `UI-SPEC.md` as design context — tasks in `PLAN.md` reference spacing tokens, color variables, and copywriting decisions that the spec locked.

---

## Related

- [Spike and sketch](spike-and-sketch.md)
- [Plan a phase](plan-a-phase.md)
- [Commands](../COMMANDS.md)
- [Docs index](../README.md)

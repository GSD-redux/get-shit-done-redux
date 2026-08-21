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
2. **`gsd-ui-checker`** — validates the resulting `UI-SPEC.md` across seven dimensions. If issues are found, a revision loop reruns the researcher (up to two iterations) targeting only the flagged items.

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
| **Component inventory** | What the design system actually provides, plus the command that enumerated it (see below) |

The checker validates the spec against its seven dimensions — Copywriting, Visuals, Color, Typography, Spacing, Registry Safety, and Inventory Provenance — returning PASS, FLAG or BLOCK for each. (The scored 1–4 six-pillar rubric belongs to `/gsd-ui-review`'s retroactive audit, not to this checker.)

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

## Record where the component inventory came from

If your project has a design system, the UI-SPEC lists the components it provides — and the
planner and executor read that list as the design surface they are allowed to build from. A list
written from the model's recall looks identical to one enumerated from the installed package, so
`gsd-ui-checker` Dimension 7 requires the spec to say which it was.

The section carries one provenance line, directly above its table:

```text
Enumerated by `npx shadcn info --json` — 153 components — @acme/design-system@4.2.1 — 2026-08-21.
```

Four things are required, and each is there for a reason:

| Part | Why it is required |
|---|---|
| The command | The only re-runnable part. A reader can check the claim without re-deriving it. |
| The count | Makes an under-listed inventory visible at a glance — "13 components" against a package reporting 153 is a difference you can see. |
| `<package>@<version>` | The **resolved installed** version, so a spec reused after an upgrade is visibly stale. A caret range from `package.json` does not do this. |
| The date | Bounds how old the claim is. |

Use whatever the design system provides — a first-party CLI with a JSON mode, an MCP tool, or the
installed package's own metadata:

```bash
npx shadcn info                                                             # shadcn projects
node -p "Object.keys(require('@acme/design-system/package.json').exports).length"
node -p "require('@acme/design-system/package.json').version"               # resolved version
```

If nothing can enumerate it, record that in the same slot instead, with a real reason:

```text
Could not enumerate: package ships no exports map and no CLI.
```

### What the checker does with it

| What the spec carries | Dimension 7 | What it means for the executor |
|---|---|---|
| Command, count, version, date | **PASS** | Sourced list. |
| Command and count, no version or date | **FLAG** | Accepted, but staleness is invisible. Add the missing part. |
| A complete line, but below the table instead of above it | **FLAG** | Accepted. Move it up — a caveat has to be read before the list it qualifies. |
| `Could not enumerate: <reason>` | **FLAG** | Honest and accepted. The list is explicitly non-exhaustive. |
| An inventory with no provenance line | **BLOCK** | Enumerate and re-run `/gsd-ui-phase`. |
| A count with no command, or a bare `Could not enumerate:` | **BLOCK** | Nothing falsifiable was recorded. |
| No inventory section at all | **PASS** | Not applicable — including every spec written before this dimension existed, and any project with `Tool: none`. Nothing to enumerate is not a defect. |

**A missing provenance line never blocks the executor.** The checker reports it against the spec
and downgrades the list to a **non-exhaustive set of known-good components** — so nothing stops
you using a component the spec simply failed to mention. Reaching for one outside the table is the
expected path, not an exception.

The checker never runs the recorded command. It reads the spec as a document; executing a command
string lifted out of one would be a code-execution path through untrusted text.

### What this check is and is not

Worth knowing before you rely on it, because the check is narrower than it looks:

- **It makes the inventory's origin falsifiable, not verified.** Nothing re-runs the command or
  compares the count against the installed package. A line that was simply made up passes. What
  you gain is that a reader — or you, six months later — can re-run the recorded command and see
  for yourself; before the field existed there was nothing to re-run.
- **It cannot tell a stale inventory from a current one.** That is what the recorded
  `<package>@<version>` is for: compare it against what is installed now. A spec reused after an
  upgrade looks exactly like a fresh one apart from that string.
- **Enforcement is applied by an agent, not by a parser.** Dimension 7 is a rule `gsd-ui-checker`
  follows, the same as the other six dimensions. It is not a schema check that runs over your
  spec, so treat a PASS as "the reviewer found a provenance line", not as a machine guarantee.
- **"The checker never runs the recorded command" is an instruction, not a sandbox.** See
  [Security model → Trade-offs and limits](../explanation/security-model.md#trade-offs-and-limits)
  for why that distinction matters and what does back it up.

None of this makes the field pointless — an unsourced inventory used to be indistinguishable from
a sourced one, and now it is not. But it is a record you can audit, not a proof.

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

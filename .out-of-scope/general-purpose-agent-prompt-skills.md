# General-Purpose Agent-Discipline Prompt Modules as Core Skills

**Source:** [#2614](https://github.com/open-gsd/gsd-core/issues/2614)
**Decision:** wontfix — routed to the capability ecosystem, closed on scope ownership
**Date:** 2026-07-24

GSD core does not accept standalone, general-purpose agent-discipline prompt
modules — prose instructing an agent *how to think* (epistemic hygiene,
confidence framing, assumption surfacing, reasoning style) that is not attached
to a specific GSD command or loop step. These belong in the capability
ecosystem, authored and distributed by their authors, not in the core skill
layer.

## What this does NOT cover

Read this scope boundary before applying the entry — the keyword surface below
("confidence", "assumptions", "reasoning style") overlaps request types this
decision deliberately does **not** deny:

- **Fixing an existing first-party agent's own language at a specific loop
  step** — e.g. "`gsd-verifier` overstates confidence at `verify:post`, tighten
  its prompt". That is command/loop-step-attached and is ordinary bug-fix or
  enhancement work. This entry denies *standalone, unattached* modules only.
- **Objectively-measured or externally-triggered calibration** — anything
  routing on an exogenous signal the way `honest-verifier.md` does. Reason 4
  below rejects *self-rated* confidence specifically; the evidence it cites
  measures the self-abstention gate and says nothing about externally-measured
  calibration, which is a categorically different mechanism.
- **Structural output-format instructions** attached to a real surface —
  separating facts from inferences from assumptions from unknowns is a
  formatting contract, not a self-assessment mechanism.

If an incoming request falls in any of the three above, this entry does not
apply to it.

## Why this is out of scope

### 1. `skills/` is a generated projection, not an authoring surface

`skills/` is build-generated from `commands/gsd/*.md` by
`scripts/gen-plugin-skills.cjs` — 71 commands to 71 skills, identical
membership — and `npm run lint:generated-sync` runs `gen-plugin-skills.cjs
--check`, which fails whenever the committed tree diverges from generator
output. A hand-authored `skills/<name>/SKILL.md` breaks CI and is not
reproduced by a regeneration.

Shipping such a module as a skill therefore requires authoring a backing
command. That converts an "adds no command surface" proposal into a new
user-facing command, which is a materially different and larger ask than the
one submitted. The skill layer's 1:1 correspondence with commands is a
load-bearing invariant read independently by `gen-plugin-skills.cjs`,
`gen-inventory-manifest.cjs`, `update-size-baseline.cjs`,
`runtime-artifact-conversion.cts`, and `install-engine.cts`. Adding the first
exception weakens it permanently for every downstream tool.

### 2. The capability system was built for exactly this

ADR-857 Decision 4 defines the `contribution` hook kind specifically so that
prompt-woven behavior can live outside core: *"without `contribution`,
prompt-woven features (security threat-model, TDD, schema gate) could never
leave the core."* Decision 5 delivers the prose to the agent via
`loop.render-hooks <point>`, which returns fully-rendered ordered markdown.

Contribution-only capabilities already ship — `capabilities/assumption-delta/`
and `capabilities/schema-gate/` declare `skills: []`, `agents: []`, `hooks:
[]`, `steps: []`, `gates: []` and extend solely through a `contributions` entry
pointing at a prose fragment, gated on a config key. That is the same shape
these proposals ask for, at roughly one-sixth the file cost of a skill: ~7
files against ~45. The skill side is dominated by per-runtime fixtures — 19
under `tests/fixtures/install-tree/` plus 19 under
`tests/fixtures/golden-install-parity/`, one per supported runtime, 38 in
total — then `docs/INVENTORY.md`, `docs/INVENTORY-MANIFEST.json`,
`docs/COMMANDS.md`, `docs/FEATURES.md`, and `workflow-size-baseline.json` on
top. (Fixture counts verified 2026-07-24; they grow with each supported
runtime, so re-count rather than citing these numbers forward.)

Since 1.6.0, capabilities install from a URL, git ref, npm package, or local
path with no core repo modification (ADR-1244 D3), and the Community Capability
Registry provides non-endorsing public discoverability through a documentation
PR. The author retains ownership, versioning, and release cadence.

### 3. Delivering it as a flag on existing commands is strictly worse

Evaluated and rejected as the alternative. Flag-gated prose injection is an
established idiom (`gsd-core/workflows/plan-phase.md:792-796` injects a whole
instruction block under `${MVP_MODE === 'true' ? … : ''}`), but the cost
multiplies by subset size: each command needs frontmatter `argument-hint`, a
workflow parse-and-branch, a `help/modes/full.md` entry, a `docs/COMMANDS.md`
row, and a hand-written test — there is no generic `COMMANDS.md` parity gate,
so enforcement is bespoke per feature. It also requires the flag on every
invocation, where a capability config key is set once. A capability's
`contributions[]` array already expresses "apply at this chosen subset of
surfaces" natively, declared once.

### 4. The core of these asks is measured as weak

Self-judged confidence reporting — the usual centerpiece of these proposals —
was measured in this project and found weak.
`gsd-core/references/honest-verifier.md:25-29`: *"Asking the verifier to
'abstain if unsure' barely moves the number (100% → 67%) and only on ambiguity
it already notices; on a true blind spot it stays confidently wrong."* That
result is why `honest-verifier.md` routes on an exogenous upstream tag and
contains no "are you sure?" prompt.

Structural output instructions (separate facts from inferences from assumptions
from unknowns; do not invent evidence; skip on casual work) are unaffected by
this finding. Self-rated confidence is not. Core will not adopt a discipline
whose central mechanism its own evidence rates as ineffective; a capability is
the correct venue to try it and gather real data.

**Revisit if** either of these becomes true — both are checkable, not
judgment calls:

1. A general agent-discipline module ships as a capability and reports a
   measured result on the same axis `honest-verifier.md:25-29` measured: a
   blind-spot set the model does *not* already flag as ambiguous, scored
   against a held-out reference set, beating the ~67% baseline recorded there.
   Self-reported improvement, anecdotes, or gains only on
   already-noticed ambiguity do not meet this bar — that is precisely the
   result the existing evidence already produced.
2. `skills/` stops being a 1:1 projection of `commands/gsd/` — i.e.
   `scripts/gen-plugin-skills.cjs` no longer generates the tree, or an ADR
   ratifies hand-authored skills. At that point reason 1 lapses on its own and
   this entry must be re-derived from reasons 2-4 alone.

## Prior requests

- #2614 — "feat: add an opt-in truth-prompt skill for evidence-aware decisions"

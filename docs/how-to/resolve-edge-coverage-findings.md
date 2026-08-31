# How to resolve edge-coverage findings while writing a spec

**Goal:** Turn each domain-boundary edge the spec phase surfaces into an explicit, verifiable spec decision — so omitted boundaries (rounding ties, touching ranges, grapheme truncation) become checkable requirements *before* any code exists, instead of silent blind spots the verifier is confidently wrong about.

**Prerequisites:** A phase whose `/gsd-spec-phase` run has passed the ambiguity gate. The edge-completeness probe (Step 5.5) then runs automatically and presents its findings — you do not invoke it separately.

For the category taxonomy and the reasoning behind front-of-pipeline edge analysis, see [Spec-Phase Edge-Completeness Probe](../FEATURES.md#144-spec-phase-edge-completeness-probe). This guide covers only how to *act* on the findings.

---

## Read a finding

Each finding is one **applicable** edge for one requirement — a boundary the probe's relevance filter decided is in scope for that requirement's shape, and that you have not yet addressed. A finding is phrased as a probe question, for example:

> **R3 · precision** — Where can precision loss, overflow, or rounding/tie-breaking occur — and what is the exact contract (e.g. half-up vs half-to-even, ceil/floor/truncate)?

You must resolve each finding into exactly one of four states. Claude presents them as a numbered choice (or an `AskUserQuestion` menu).

You may also see an **`unclassified — review manually`** finding. The relevance filter is a heuristic over prose cues, so a requirement whose wording is edge-relevant but matched no cue surfaces this single soft candidate instead of being silently dropped. Resolve it like any other finding — specify a criterion, or **dismiss it with a reason** if the requirement is genuinely edge-free (e.g. "static asset, no input"). It is a manual-review nudge, never a hard block.

---

## Specify it — write an acceptance criterion

**Choose this when you can state the correct behaviour as a pass/fail check.** This is the strongest resolution: it produces a concrete assertion the planner and verifier can enforce.

Claude writes a new line into the spec's **Acceptance Criteria** and marks the edge `covered`. For the `precision` finding above:

> - [ ] Monetary amounts round half-to-even to 2 decimal places; `2.005 → 2.00`

Prefer this state whenever a defensible criterion can be written. A `covered` edge is lifted into the plan's `must_haves.truths`, so the verifier checks it.

---

## Dismiss it — record why it does not apply

**Choose this when the edge genuinely cannot occur** — and say why. A dismissal **requires a non-empty reason**; silence is rejected. The reason is the audit trail.

> ⛔ dismissed — input is a bounded enum; no boundary value exists

A wrong dismissal is the exact silent failure this probe exists to prevent, so dismiss only when the reason is solid.

---

## Backstop it — defer the contract to a held-out test

**Choose this when you know the edge matters but cannot fully articulate the correct behaviour in prose yet.** Claude marks the edge `backstop` and notes that a held-out / property-based test stands in for the missing assertion.

> 🧪 backstop — held-out property test: dedupe output order is stable under input permutation

A `backstop` edge is also carried into the plan's `must_haves.truths` as a non-inferable check — the planner records the intent, and the test body is authored later during execution.

---

## Defer it — leave it unresolved and flagged

**Choose this only when you are not ready to decide.** The edge stays `unresolved` and is flagged. Unlike a dismissal, deferring makes no claim that the edge is safe — it is an explicit, visible assumption the planner must surface, not silently drop.

---

## Clear the soft gate

After you have worked through the findings, the probe runs a **soft gate**:

- **All applicable edges resolved** → the spec proceeds to the next step.
- **One or more still `unresolved`** → Claude asks what to do:
  - **Resolve now** — loop back and resolve the remaining edges.
  - **Write the spec anyway** — the spec is written with those rows marked `⚠ Edge unresolved — planner must treat as assumption`. Use this deliberately; you are choosing to ship a known gap.

The gate is *soft*: it never blocks you, but every unresolved edge remains visible in the spec's `## Edge Coverage` section.

---

## Let Claude resolve them for you

**If the edges are low-stakes or already implied by earlier phases**, run the spec phase in auto mode:

```bash
/gsd-spec-phase 3 --auto
```

In `--auto`, Claude marks an edge `covered` where it can write a defensible acceptance criterion, and `backstop` otherwise. It **never auto-dismisses** — dismissing an edge requires a human reason, because a wrong auto-dismissal is precisely the silent failure being eliminated. Claude logs the tally, for example:

```
[auto] edge coverage: 4 covered, 2 backstop, 1 unresolved
```

Review the logged choices afterwards; auto mode is a fast first pass, not a substitute for judgement on edges that carry risk.

---

## What happens to resolved findings downstream

When you next run `/gsd-plan-phase`, the planner reads the spec's `## Edge Coverage` section and:

- lifts every `covered` edge's acceptance criterion into `must_haves.truths`,
- carries every `backstop` edge into `must_haves.truths` as a non-inferable check (needing a held-out/property test),
- surfaces every `unresolved` edge as an explicit assumption.

This is the payoff: a resolved edge becomes a unit the goal-backward verifier actually checks, extending its reach to boundaries the requirement prose never stated.

---

## Related

- [Spec-Phase Edge-Completeness Probe](../FEATURES.md#144-spec-phase-edge-completeness-probe) — taxonomy, output schema, and the front-of-pipeline rationale
- [`/gsd-spec-phase`](../COMMANDS.md#gsd-spec-phase) — command reference and flags
- [Plan a phase](plan-a-phase.md) — where `covered`/`backstop` edges become `must_haves`
- [docs index](../README.md)

# How to probe edges in a non-English project

**Goal:** Get real edge-completeness coverage on a spec written in a language other than English, instead of every requirement landing in `unclassified` and the whole taxonomy quietly contributing nothing.

**Prerequisites:** A project with `response_language` set (see [Configuration](../CONFIGURATION.md)), and a phase whose `/gsd-spec-phase` run has passed the ambiguity gate. The edge-completeness probe (Step 5.5) then runs automatically — you do not invoke it separately.

For the taxonomy and the reasoning behind front-of-pipeline edge analysis, see [Spec-Phase Edge-Completeness Probe](../FEATURES.md#144-spec-phase-edge-completeness-probe). For how to act on findings once they appear, see [Resolve edge-coverage findings](resolve-edge-coverage-findings.md). This guide covers only what is different when your spec is not in English.

---

## What happens, and why

The probe classifies each requirement's data/behavior shape by matching **English** word-boundary cues against the requirement text. A requirement written in another language matches nothing, classifies to zero shapes, raises zero categories, and surfaces as a single `unclassified — review manually` row.

That is not a rejection you can act on — it looks identical to a genuinely edge-free requirement. When it happens to *every* requirement, the probe has contributed nothing to the spec.

So Step 5.5 populates an optional `text_en` field alongside each requirement — a faithful English translation — which the engine reads in preference to `text` for classification (`text_en ?? text`). Your spec's own `text` stays in your language throughout. Concretely, for the same requirement:

| Requirement `text` | Requirement `text_en` | Shapes | Edges raised |
|---|---|---|---|
| `O sistema mescla intervalos sobrepostos em uma lista ordenada` | *(absent)* | none | none — one `unclassified` row |
| `O sistema mescla intervalos sobrepostos em uma lista ordenada` | `The system merges overlapping intervals in a sorted list` | `collection` | `adjacency`, `empty`, `ordering` |

## What you do

Nothing extra. The translation happens inside Step 5.5 as part of the run, populating the engine-only `text_en` field.

What you should *see* is the split: your **spec stays in `response_language`** — its requirements, its acceptance criteria, its `## Edge Coverage` section — while the probe's findings are reasoned about from `text_en`, an English rendering of the requirement text that lives alongside (never in place of) your requirement's own `text`. Requirement ids (`R1`, `R2`, …) are never translated or renumbered, so a finding always names the same requirement you wrote.

If your spec comes back anglicized, that is a bug worth reporting — only the transient `text_en` field is translated, never the document.

## Tell "no edges here" apart from "the probe could not read it"

This is the distinction that matters, because both look like an `unclassified` row.

| What you see | What it means | What to do |
|---|---|---|
| A few `unclassified` rows among normally-classified ones | Those requirements carry no shape cue **in any language**. This is the classifier's known recall gap, not a translation problem. | Resolve each like any other finding — or author an explicit `shapes` array on the requirement (below). |
| **Every** requirement `unclassified`, and a `WARNING: edge-probe proposed ZERO applicable edges` | The probe could not read your requirements at all. | Confirm the run really is translating the probe input. Do not accept an empty `## Edge Coverage` section. |
| Some requirements classified, the rest `unclassified`, no warning | **The silent case.** The zero-applicable warning fires only when *all* requirements are unclassified, so a partly-classified spec raises nothing. | Check the `unclassified` ones individually against the row above. |

Translation makes the classifier *applicable*; it does not make it omniscient. A requirement carrying no shape cue in English either — for example "the command exits with code 1 on invalid input" — still classifies to zero. That is expected, and the fix is the same one an English-language project uses.

## Force the shape when the prose carries no cue

When a requirement is genuinely edge-relevant but no cue fires, do not fight the wording. Author the shape explicitly — an authored `shapes` array bypasses prose classification entirely, in any language:

```json
{ "id": "R4", "text": "The command exits with code 1 on invalid input", "shapes": ["stateful"] }
```

`shapes` accepts any of `numeric-range`, `collection`, `text`, `stateful`, `io`. The example above raises `idempotency` and `concurrency`.

An explicit empty array — `"shapes": []` — is the opposite signal: your deliberate "this requirement has no edge surface", which stays silent rather than surfacing an `unclassified` row.

## Related

- [Resolve edge-coverage findings](resolve-edge-coverage-findings.md) — what to do with each finding once it is raised
- [Spec-Phase Edge-Completeness Probe](../FEATURES.md#144-spec-phase-edge-completeness-probe) — the taxonomy and the rationale
- [Configuration](../CONFIGURATION.md) — the `response_language` setting

# UI-Consideration Probe — Spec-Completeness Reference

The **third** adapter of the shared `probe-core` resolution model (ADR-550 Decision 7), on
the **UI element/state axis**. It surfaces the shape-rooted UI *state* considerations a
UI-SPEC must resolve before a dimension may PASS — the visual analog of the requirement-side
[edge-probe](./edge-probe.md), reusing its exact lifecycle, validators, and plan-phase lift
(see edge-probe.md for the shared status×verification model — this doc does not re-argue it).

**Axis boundary (this is a MIXED axis).** This compiled taxonomy covers ONLY the finite,
project-independent shape-rooted content/robustness states. The **open**, domain/UX-dependent
considerations — real-time/offline/optimistic-UI, deep accessibility (WCAG breadth),
internationalization / RTL depth, and emerging interaction paradigms — are open-ended and are
prose-owned in the companion [domain-probes.md](./domain-probes.md) technology/UX bank, NOT
here. Forcing them into a closed compiled taxonomy is the wrong model.

## Inputs

A list of UI elements, each a `{ id, text, elements? }` record where `text` is the
researcher-authored description and `elements` is an optional author-supplied override of the
element classification. The six element kinds are: `form`, `list-collection`, `nav`, `media`,
`interactive-control`, `static-content`. When `elements` is absent, a heuristic classifier
proposes kinds from the prose (propose-then-confirm) — the author may correct the kind.

## Taxonomy (8 categories)

Closed and small by design: the finite, project-independent content/robustness states every
UI surface must account for. Growth toward open UX topics happens in `domain-probes.md`, not by
bloating this closed core.

| id | name | applies to element kinds | consideration question |
|----|------|--------------------------|------------------------|
| empty | Empty / no data | form, list-collection, media | What is shown when there is no data — zero items, an unfilled form, or absent media? |
| loading | Loading / in-flight | form, list-collection, media, nav, interactive-control | What is shown while data or content is still loading (skeleton, spinner, progressive reveal)? |
| error | Error / failure | form, list-collection, media, nav, interactive-control | What is shown when the load or submit fails (message, retry affordance, partial fallback)? |
| populated | Populated / happy path | list-collection, media | What does the normal populated (happy-path) state look like at a typical volume of content? |
| partial | Partial / incomplete | form, list-collection | What is shown for partial or incomplete data — some fields or rows present, others missing? |
| overflow | Overflow / truncation | list-collection, nav, static-content | What happens when content exceeds its container — scroll, clip, wrap, or truncate? |
| zero-one-many | Zero / one / many | list-collection | How does the layout read at zero, one, and many items (singular vs plural copy, spacing)? |
| long-text | Long text | form, static-content, interactive-control, nav | What happens with unusually long text — truncation, wrapping, ellipsis, or reflow? |

## Relevance filter + resolution states

The probe reuses the edge-probe rails verbatim (ADR-550 Decision 7 — see
[edge-probe.md](./edge-probe.md#relevance-filter--resolution-states) for the full model):

1. **Relevance filter first.** Classify each element's kind(s), then raise only the categories
   whose `applies to element kinds` intersect. A static label is never asked about loading or
   empty state — that is what makes an unresolved consideration meaningful.
2. **Dismissal requires a reason string.** Silence is not a resolution; the reason is the audit
   trail.
3. **Zero-classification surfaces one `unclassified` candidate (#1110).** An element whose prose
   matched no kind cue yields exactly one soft `unclassified — review manually` item
   (`category: "unclassified"`, `status: "unresolved"`) — never a silent drop, never a guessed
   kind. `unclassified` is a review signal, **not** a ninth taxonomy category; an explicit
   `elements: []` opt-out stays silent.

Each raised consideration carries the shared two orthogonal axes — `status`
(`resolved | dismissed | unresolved`) and, when resolved, a `verification` tier
(`explicit | backstop`). A `backstop` consideration lifts into `must_haves.truths` and, at
verify time, is confirmed only by explicit evidence (a wired held-out/property test) or routes
to `insufficient_spec → human_needed` — never a silent pass (the honest-verifier disposition,
#1154). See [honest-verifier.md](./honest-verifier.md).

## Closed / open boundary

The **8 ids above are the closed, compiled subset** — finite and project-independent, so a
compiled taxonomy is legitimate (the same property that makes edge-probe's data-shape taxonomy
closed). The **open subset is prose-owned in [domain-probes.md](./domain-probes.md)**:
real-time/offline/optimistic-UI, deep accessibility (WCAG breadth), i18n / RTL depth, and
emerging interaction paradigms (gesture/voice/reduced-motion/print) are open-ended and
cue-triggered — they do not belong in this closed taxonomy. This probe **complements** the
`gsd-ui-checker` six quality dimensions (it adds a state-coverage axis); it does not change the
BLOCK/FLAG/PASS enum or the dimensions themselves.

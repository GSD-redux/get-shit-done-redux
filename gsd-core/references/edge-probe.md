# Edge-Probe — Spec-Completeness Reference

Shared reference for the spec/requirements phase. Companion to
`@~/.claude/gsd-core/references/domain-probes.md`: `domain-probes` covers the
**technology axis** (auth, search, caching, deployment); this covers the
**data/behavior-shape axis** (boundaries, adjacency, encoding, ordering…). Walk each
requirement against the closed taxonomy below, propose a concrete candidate edge for each
applicable category, and resolve each to exactly one state. Adopt the established QA names
verbatim — this is decades-old black-box test technique, moved upstream to the spec layer.

This doc is written in generic `requirements → checks → verifier` terms with no
tool-specific vocabulary, so it is portable: copy it into any spec/requirements process.
A short mapping table at the end binds it to common host structures.

## Why front-of-pipeline

A goal-backward verifier only checks assertions that exist; an assertion only exists for a
requirement that was written down. A domain-boundary edge the author never surfaced is
invisible to the verifier — and worse, the verifier is *confidently wrong* about it
(measured: ~0.93 confidence while catching 0/12 omitted-edge defects, an expected
calibration error of 0.81 — worse than a coin flip — versus 100% / 0.03 on edges the spec
did state). The fix is not a better verifier or a confidence gate; confidence is
uninformative across these regimes. The fix is **spec completeness**: surface the omitted
edge into an explicit, checkable assertion *before* any code exists, after which the
verifier reliably catches it.

The underlying techniques are classic and should be named as such — **Boundary Value
Analysis**, **Equivalence Partitioning**, the **Category-Partition method**, and
**Metamorphic Relations**; property-based testing (PBT) is the academic name for the
held-out backstop. The literature applies these at the *test* layer (back of pipeline,
generating checks). The differentiated move here is **placement, not technique**: apply the
same edge taxonomy at the *spec* layer (front of pipeline, generating requirements), with
the explicit goal of extending a verifier's reach. Recent LLM spec work corroborates the
core finding that the spec layer is the measured weak point:

- SLD-Spec — program slicing + logical deletion (code→spec): arXiv 2509.09917
- Specine / AutoReSpec / SpecMind — spec alignment & postcondition inference
- CodeSpecBench (2604.12268), OSVBench (2504.20964), VERINA (2505.23135) — benchmarks
  showing models solve tasks far better than they generate precise behavioral specs
- LLM property-based tests for edge cases: arXiv 2510.25297 (PBT+EBT ≈ 81% edge detection)

## Inputs

A list of requirements, each a `{ id, text, text_en?, shapes? }` record where `text` is a
testable statement, `text_en` is an optional English translation of `text`, and `shapes` is an
optional author-supplied override of the data/behavior shape. The five shapes are:
`numeric-range`, `collection`, `text`, `stateful`, `io`. When `shapes` is absent, a heuristic
classifier proposes them from the requirement prose — reading `text_en` in preference to
`text` when present (`text_en ?? text`) — (propose-then-confirm); the author may correct the
shape.

**The classifier reads English; `text` does not have to be.** The heuristic cues (`SHAPE_CUES`)
are English word-boundary patterns, so a requirement whose `text` is not English classifies to
zero shapes unless `text_en` supplies a faithful English translation. A project running with
`response_language` set should populate `text_en` for every requirement; `text` keeps its own
meaning — the requirement's own text, in whatever language the SPEC uses — and is never
translated or overwritten. `text_en` is engine input, not part of the SPEC. `id` is never
translated. Prose that matches no cue in either field surfaces as `unclassified` (#1110) — the
probe contributes nothing for that requirement. Where a requirement carries no cue even in
English, author `shapes` explicitly rather than leaning on the classifier.

## Taxonomy (8 categories)

Closed and small by design: a fixed eight the author must explicitly clear beats thirty
nobody finishes. The failure mode being eliminated was never "too few categories" — it was
that no taxonomy was *systematically applied at all*. Categories 1, 2, and 4 alone cover
the three canonical corpus defects (banker's-rounding ties, touching intervals, grapheme
truncation). Growth happens via optional domain packs, not by bloating the core.

| id | name (QA term) | applies to shapes | probe question |
|----|----------------|-------------------|----------------|
| boundary | Boundary values | numeric-range | What happens exactly at each min/max/threshold — and one step either side? |
| adjacency | Adjacency / touching | collection | When two things are exactly equal or just touch, do they merge, collide, or separate? |
| empty | Empty / degenerate | collection, text | What is the result for empty, single-element, or null input? |
| encoding | Encoding / representation | text | Whose definition of length/equality applies — bytes, code points, grapheme clusters, or normalized form? |
| ordering | Ordering / stability | collection | When elements compare equal, is output order specified and stable? |
| precision | Precision / overflow | numeric-range | Where can precision loss, overflow, or rounding/tie-breaking occur — and what is the exact contract (e.g. half-up vs half-to-even, ceil/floor/truncate)? |
| idempotency | Idempotency / repetition | stateful | What happens if this runs twice on the same input? |
| concurrency | Concurrency / effect ordering | stateful, io | If interrupted or run in parallel, what is guaranteed? |

## Relevance filter + resolution states

Two rules keep the probe honest and prevent an "everything is N/A" failure mode:

1. **Relevance filter first.** Classify each requirement's shape, then raise only the
   categories whose `applies to shapes` intersect that requirement's shapes. A pure-text
   requirement is never asked about overflow. This is what makes an unresolved edge
   meaningful: it is an edge that *applies* and was not addressed.
2. **Dismissal requires a reason string.** "N/A — input is a bounded enum, no boundary
   exists" is valid; silence is not. The reason string is the audit trail.

**Zero-classification surfaces an `unclassified` candidate (#1110).** The relevance filter is
a heuristic over prose cues, so a requirement whose wording *is* edge-relevant but matches no
shape cue would otherwise classify to zero shapes → zero edges and vanish from coverage with
no signal — the same silent blind spot the probe exists to catch. Instead, a requirement with
non-empty prose, no authored `shapes`, and zero matched shapes surfaces exactly one soft
`unclassified — review manually` candidate (`category: "unclassified"`, `status: "unresolved"`).
It is a dismissible nudge — resolve it, or dismiss it with a reason (e.g. a genuinely edge-free
static-asset requirement) — never a hard block. `unclassified` is a review signal, **not** a
ninth taxonomy category: the closed eight above are unchanged, and an explicit `shapes: []`
opt-out stays silent (the author's deliberate "no edge surface").

Each raised edge carries two orthogonal axes — a resolution **lifecycle** and, when
resolved, a **verification** tier (ADR-550 Decision 7, the shared probe-core model):

- **status** — `resolved | dismissed | unresolved`:
  - **resolved** — the edge is addressed; *how* it is addressed is the verification tier.
  - **dismissed** — not applicable, accompanied by a required, non-empty reason string.
  - **unresolved** — carried forward and flagged; the author chose not to resolve it yet.
- **verification** (only when `status` is `resolved`; `null` otherwise) — `explicit | backstop`:
  - **explicit** — a checkable assertion for the edge is written (a SPEC acceptance criterion).
  - **backstop** — a held-out / property-based test stands in for an edge the author knows
    but cannot fully articulate in prose (records intent; the test body is authored later).

Splitting these axes keeps the lifecycle enum free of a verification fact (the old single
enum smuggled `covered`/`backstop` — both *resolved* — into one flat list) and lets sibling
probes add their own verification tiers (e.g. `test | judgment`) without a parallel enum.

`coverage.resolved` is the count of **closed** edges — `resolved` + `dismissed` (the
pre-re-cut "covered + dismissed + backstop" set, count-preserved). An `unresolved`
*applicable* edge is the precise signal a soft completeness gate raises.

## Output schema

The probe emits, per edge, an item of the form:

```
{ requirement_id, category, status, verification, resolution, reason, probe }
```

plus a coverage summary:

```
coverage: { applicable, resolved, unresolved, byVerification: { explicit, backstop } }
```

`applicable` is the number of raised edges, `resolved` = closed (`resolved` + `dismissed`)
status edges, `unresolved` is the remainder, and `byVerification` breaks the
`resolved`-status edges down by tier (probe-agnostic in core; the edge adapter declares
`{ explicit, backstop }`). This JSON is the stable contract both the reference
implementation and any third-party port emit.

## Generic mapping (requirements → checks → verifier)

| Host structure | "requirement" | a `resolved`/`explicit` edge becomes | a `resolved`/`backstop` edge becomes |
|----------------|---------------|--------------------------|---------------------------|
| GSD SPEC | a SPEC Requirement | an Acceptance Criterion that `plan-phase` lifts into `must_haves.truths` | a non-inferable check in `must_haves.truths` (needs a held-out/PBT test) |
| Gherkin feature | a Scenario | an additional `Then` assertion / Scenario Outline row | a tagged scenario routed to a property test |
| OpenAPI operation | an operation | a response/constraint example + schema rule | a contract/property test on the operation |
| Docstring contract | a documented behavior | an assertion in the contract test | a property-based test for the function |

The portable invariant: a `resolved`/`explicit` edge produces **the unit your verifier
iterates over** (GSD: a `must_haves.truth`); a `resolved`/`backstop` edge produces a test
added to that same set as a non-inferable check. An `unresolved` edge is an explicit
assumption the downstream planner must surface, not silently drop.

## Worked example (merge-intervals)

Given a single requirement with no resolutions yet:

```
[{ "id": "R1", "text": "Merge a list of overlapping intervals into the minimal set" }]
```

the requirement classifies as a `collection`, which raises `adjacency`, `empty`, and
`ordering` (but not `boundary`/`precision`/`encoding`/`idempotency`/`concurrency`). With no
resolutions supplied, every applicable edge is `unresolved`:

```json edge-probe:02-merge-intervals/expected-coverage.json
{
  "items": [
    { "requirement_id": "R1", "category": "adjacency", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "When two things are exactly equal or just touch, do they merge, collide, or separate?" },
    { "requirement_id": "R1", "category": "empty", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "What is the result for empty, single-element, or null input?" },
    { "requirement_id": "R1", "category": "ordering", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "When elements compare equal, is output order specified and stable?" }
  ],
  "coverage": { "applicable": 3, "resolved": 0, "unresolved": 3, "byVerification": { "explicit": 0, "backstop": 0 } }
}
```

The `adjacency` row is the one that catches the canonical defect: `[[1,2],[2,3]]` intervals
that only *touch* — does the spec say they merge? Resolving it `resolved`/`explicit` writes
that assertion, and the verifier can then enforce it. This worked-example block is kept
byte-for-byte (parsed-JSON) identical to its fixture by `edge-probe-docs-fixtures.test.cjs`,
so the doc and the reference implementation cannot silently drift.

## Worked example (round-half-even)

Given a requirement to round floating-point values using the banker's-rounding (half-even)
rule, the requirement classifies as `numeric-range`, which raises `boundary` and `precision`
(but not `adjacency`/`empty`/`ordering`/`encoding`/`idempotency`/`concurrency`):

```json edge-probe:01-round-half-even/expected-coverage.json
{
  "items": [
    { "requirement_id": "R1", "category": "boundary", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "What happens exactly at each min/max/threshold — and one step either side?" },
    { "requirement_id": "R1", "category": "precision", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "Where can precision loss, overflow, or rounding/tie-breaking occur — and what is the exact contract (e.g. half-up vs half-to-even, ceil/floor/truncate)?" }
  ],
  "coverage": { "applicable": 2, "resolved": 0, "unresolved": 2, "byVerification": { "explicit": 0, "backstop": 0 } }
}
```

The `precision` row surfaces the canonical defect for this requirement: IEEE 754 floating-point
arithmetic rounds 2.5 to 2 (not 3) under half-even — the probe asks whether the spec
states that contract explicitly, so the verifier can enforce it.

## Worked example (truncate-graphemes)

Given a requirement to truncate a string to N grapheme clusters (not bytes or code points),
the requirement classifies as `text`, which raises `empty` and `encoding`:

```json edge-probe:03-truncate-graphemes/expected-coverage.json
{
  "items": [
    { "requirement_id": "R1", "category": "empty", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "What is the result for empty, single-element, or null input?" },
    { "requirement_id": "R1", "category": "encoding", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "Whose definition of length/equality applies — bytes, code points, grapheme clusters, or normalized form?" }
  ],
  "coverage": { "applicable": 2, "resolved": 0, "unresolved": 2, "byVerification": { "explicit": 0, "backstop": 0 } }
}
```

The `encoding` row is the load-bearing one: a requirement that says "truncate to 10
characters" is ambiguous — the spec must state whether "character" means bytes, UTF-16
code units, Unicode code points, or grapheme clusters (emoji sequences are 1 grapheme,
multiple code points).

## Worked example (money-rounding)

Given a requirement to round monetary amounts to two decimal places, the requirement
classifies as `numeric-range`, which raises `boundary` and `precision`:

```json edge-probe:04-money-rounding/expected-coverage.json
{
  "items": [
    { "requirement_id": "R1", "category": "boundary", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "What happens exactly at each min/max/threshold — and one step either side?" },
    { "requirement_id": "R1", "category": "precision", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "Where can precision loss, overflow, or rounding/tie-breaking occur — and what is the exact contract (e.g. half-up vs half-to-even, ceil/floor/truncate)?" }
  ],
  "coverage": { "applicable": 2, "resolved": 0, "unresolved": 2, "byVerification": { "explicit": 0, "backstop": 0 } }
}
```

The `boundary` row asks what the minimum and maximum representable values are (negative
amounts? fractional cents?). The `precision` row asks whether IEEE 754 binary rounding
can produce `$0.30000000000000004` — the spec must commit to a representation.

## Worked example (list-dedupe)

Given a requirement to deduplicate a list of items, the requirement classifies as
`collection`, which raises `adjacency`, `empty`, and `ordering`:

```json edge-probe:05-list-dedupe/expected-coverage.json
{
  "items": [
    { "requirement_id": "R1", "category": "adjacency", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "When two things are exactly equal or just touch, do they merge, collide, or separate?" },
    { "requirement_id": "R1", "category": "empty", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "What is the result for empty, single-element, or null input?" },
    { "requirement_id": "R1", "category": "ordering", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "When elements compare equal, is output order specified and stable?" }
  ],
  "coverage": { "applicable": 3, "resolved": 0, "unresolved": 3, "byVerification": { "explicit": 0, "backstop": 0 } }
}
```

The `ordering` row is the non-obvious one: dedupe removes duplicates, but which copy is
kept — first occurrence, last, or implementation-defined? The spec must commit.

## Worked example (resolved-mixed)

The same merge-intervals requirement after a resolution session where `adjacency` was
resolved with an explicit acceptance criterion, `ordering` was dismissed, and `empty` was
left unresolved:

```json edge-probe:06-resolved-mixed/expected-coverage.json
{
  "items": [
    { "requirement_id": "R1", "category": "adjacency", "status": "resolved", "verification": "explicit", "resolution": "AC#6: touching intervals merge", "reason": null, "probe": "When two things are exactly equal or just touch, do they merge, collide, or separate?" },
    { "requirement_id": "R1", "category": "empty", "status": "unresolved", "verification": null, "resolution": null, "reason": null, "probe": "What is the result for empty, single-element, or null input?" },
    { "requirement_id": "R1", "category": "ordering", "status": "dismissed", "verification": null, "resolution": null, "reason": "output is canonically sorted; no tie possible", "probe": "When elements compare equal, is output order specified and stable?" }
  ],
  "coverage": { "applicable": 3, "resolved": 2, "unresolved": 1, "byVerification": { "explicit": 1, "backstop": 0 } }
}
```

`coverage.resolved` is 2 — the closed set (adjacency=`resolved`/`explicit` + ordering=`dismissed`);
`unresolved` is 1 (empty); `byVerification.explicit` is 1 (the single explicitly-verified
edge), `backstop` 0. The soft gate raises on this example because one applicable edge remains
unresolved — the author must either specify, dismiss, or backstop it before writing the SPEC.

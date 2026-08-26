---
id: 144
title: Spec-Phase Edge-Completeness Probe
group: v1.42.1 Features
---

**Command:** `/gsd-spec-phase`

**Purpose:** Surface the omitted domain-boundary edges that silently invalidate a requirement — touching intervals, empty inputs, rounding ties, grapheme truncation — before they become production defects. Runs as `Step 5.5` of spec-phase, after the ambiguity gate.

**Behavior:** For each SPEC requirement the probe classifies its data/behavior shape, then raises only the *applicable* categories from a closed 8-category taxonomy (boundary, adjacency, empty, encoding, ordering, precision, idempotency, concurrency) via a relevance filter. Each raised category proposes one concrete candidate edge, which the author resolves to exactly one of four states:

| State | Meaning | Downstream effect |
|-------|---------|-------------------|
| `covered` | An acceptance criterion handles the edge | Pass/fail line written into the SPEC Acceptance Criteria block; lifted into `plan-phase` `must_haves.truths` |
| `dismissed` | The edge cannot occur (requires a non-empty reason) | Recorded with its reason; empty dismissals are rejected |
| `backstop` | Intent recorded, needs a held-out/property-based test | Lifted into `must_haves.truths` as a non-inferable check |
| `unresolved` | Deferred | Soft-gates the spec; row stamped `⚠ Edge unresolved — planner must treat as assumption` |

When a requirement's prose matches **no** shape cue, the probe does not silently drop it (#1110): it emits a single `unclassified — review manually` candidate so the zero-cue requirement is surfaced for the author to resolve like any other (specify / dismiss-with-reason / defer) — a manual-review nudge, not a hard block.

**Non-English projects: the probe reads English, the SPEC does not have to (#2773).** The shape cues are English word-boundary patterns, so a project running with [`response_language`](CONFIGURATION.md) set would otherwise have *every* requirement match nothing, classify to zero shapes, and land in `unclassified` — the taxonomy silently contributing nothing to exactly the kind of spec it exists to harden. `spec-phase` Step 5.5 therefore feeds the probe a faithful **English translation** of each requirement's `text`: that payload is engine input, never user-facing output, so it is translated while the SPEC itself stays in the original language, requirement ids are left untouched, and any acceptance criteria written back from the resolved edges return to `response_language`. Translation makes the classifier *applicable*; it does not make it omniscient. A requirement carrying no shape cue in **any** language still classifies to zero — that is the classifier's recorded recall gap (ADR-857 §98), not a translation failure — and the remedy there is the same one an English project uses: author an explicit `shapes` array on the requirement instead of relying on prose classification.

The resolved edges populate a `## Edge Coverage` section in `SPEC.md`. Unresolved *applicable* edges trigger a soft gate (Resolve / Write-anyway-flagged / Keep-probing) rather than a hard block. Under `--auto`, the probe **never auto-dismisses** — it auto-covers where a defensible criterion exists, otherwise auto-backstops, and logs `[auto] edge coverage: C covered, B backstop, U unresolved`. The one exception is an `unclassified` candidate: `--auto` leaves it **`unresolved`** (surfaced as a flagged assumption), never auto-`backstop` — a missing shape is not evidence an edge exists, so minting a held-out edge obligation would be a false claim.

The load-bearing wire is the `plan-phase` lift: `covered` and `backstop` edges become `must_haves.truths` the verifier can check, so the section is not merely documentation. A `backstop` edge is lifted as a **structured non-inferable marker** (`{ statement, verification: backstop }`, a flat scalar — not a prose note), which the **honest verifier** then consumes (see below) — closing the loop the edge-probe opened.

**Honest verifier — abstention on non-inferable checks (#1154).** A non-inferable (`backstop`) truth is one whose correct behavior is not derivable from the spec alone, so the verifier cannot self-detect the gap and would confidently false-pass it (~100% of the time). At verify time, a `backstop` truth the verifier cannot confirm with **explicit evidence** (a passing wired held-out/property-based test, or a directly-observed behavior) **abstains** → `human_needed` with reason `insufficient_spec` (reported as `unverified — held-out test recommended`), **never a silent `passed`**. This is the verify-time, truth-axis mirror of the prohibition judgment-tier disposition (ADR-550 D4): exogenous (driven by the `backstop` tag, never a self-judged "abstain if unsure"), routing-not-diagnosis (the held-out test carries the omitted rule), and capable-tier dependent (reliable on `sonnet`+; the budget `haiku` tier degrades toward current behavior). An inferable truth is never abstained (the over-abstention guard). Reference: [Honest Verifier](../gsd-core/references/honest-verifier.md).

**Requirements:**
- REQ-EDGE-01: The edge pass MUST run after the ambiguity gate and emit a `## Edge Coverage` SPEC section.
- REQ-EDGE-02: The relevance filter MUST raise only applicable categories; each raised edge resolves to exactly one of covered/dismissed/backstop/unresolved.
- REQ-EDGE-03: A `dismissed` resolution MUST require a non-empty reason.
- REQ-EDGE-04: An unresolved applicable edge MUST trigger the soft gate; write-anyway stamps the row as a planner assumption.
- REQ-EDGE-05: `--auto` MUST never auto-dismiss — auto-cover or auto-backstop only.
- REQ-EDGE-06: `plan-phase` MUST lift `covered` criteria and `backstop` notes into `must_haves.truths`.
- REQ-EDGE-07: A requirement whose prose matches no shape cue MUST surface an `unclassified — review manually` candidate (never silently dropped); `--auto` MUST leave it `unresolved`, never auto-`backstop`.
- REQ-EDGE-08: `plan-phase` MUST lift a `backstop` edge into `must_haves.truths` as a structured flat-scalar marker (`{ statement, verification: backstop }`), never a prose parenthetical.
- REQ-HONEST-01: At verify time a `backstop` truth that cannot be confirmed with explicit evidence MUST abstain → `human_needed` (reason `insufficient_spec`), never `passed`; an inferable truth MUST never be abstained (over-abstention guard); abstention MUST be exogenous (driven by the `backstop` tag, not self-judgment).

**Reference:** [Edge Probe](../gsd-core/references/edge-probe.md)

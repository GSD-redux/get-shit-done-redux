# ADR 1606: prohibition-enforcement verify-time seam [Proposed]

- **Status:** Proposed (consolidation ADR — see "Relationship to ADR-550")
- **Date:** 2026-06-22

> **Provenance.** Drafted 2026-06-22 to promote a decision that accreted as **four**
> chronological addendum blocks on ADR-550 (the 2026-06-12 test-tier disposition note that
> folded in #1259, then #1279, #1346, and #1278) into a single, first-class architecture-of-
> record for the verify-time enforcement subsystem. Authored by the #644/#1259 implementer.
> The *area* (why prohibitions are first-class at all) traces to the author's
> prohibition-elicitation (N18) and verifier-abstention (N17) findings — *the author's own
> research*, cited as motivation, not claimed as a novel GSD contribution; the *enforcement
> mechanism* in this ADR is motivated specifically by closing the caller-attestation fake-
> green hole. Verified against `next` + `src/prohibition-enforcement.cts` (≈43KB) and
> `gsd-core/references/prohibition-probe.md`.

## Relationship to ADR-550 (read this first)

ADR-550 is the **spec-phase probe contract**: what a prohibition *is*, how it is
represented (`SPEC.md` acceptance criterion ↔ `must_haves.prohibitions:`), and how it is
*tiered* (`test` vs `judgment`, Decisions 3–7). That ownership is unchanged.

This ADR carves out and consolidates the **verify-time enforcement mechanism** for the
`test` tier — the `check prohibition-enforcement` producer in
`src/prohibition-enforcement.cts` — which ADR-550 only documents as a chain of dated
addenda. The boundary:

| Concern | Owner |
|---------|-------|
| Prohibition representation, tiering, spec→plan projection | **ADR-550** (D3, D7) |
| Judgment-tier soft-gate / "never a silent pass" policy | **ADR-550** (D4) |
| Test-tier *enforcement producer* (locate → prove-fail-first → run → dispose) | **this ADR** |
| Capability/core-rail placement of the verifier↔predicate contract | **ADR-857** *"Verification substrate vs. plug-in tier (the predicate boundary)"* (decision #6), referenced by both |

**Dedup proposal (decide at PR review):** on accepting this ADR, replace ADR-550's
2026-06-12 / #1259 / #1279 / #1346 / #1278 enforcement addenda with a one-line pointer to
this ADR, leaving 550 to own the contract and this ADR to own the mechanism. Until that is
agreed, 550's addenda remain authoritative and this ADR is non-binding.

## Why this is still `Proposed` (audited 2026-07-17)

**What shipped.** The audit confirmed the enforcement mechanism this ADR describes is real
and in place, not aspirational. All seven Decision points are present in
`src/prohibition-enforcement.cts` and `src/probe-core.cts`: `runProhibitionEnforcement`
(`src/prohibition-enforcement.cts:654-732`), `dispositionForProhibition`
(`src/probe-core.cts:470-516`), the vacuity guards `isNonVacuousNodeTestRed`
(`src/prohibition-enforcement.cts:351-355`) and `isNonVacuousNodeTestPass`, and
`defaultProveFailFirst`'s node-test branch (`src/prohibition-enforcement.cts:591-627`) —
which does implement the #1906 mandatory-`cleanFixture` causation control exactly as
Decision 4 / the 2026-07-03 addendum describe, not merely as a documented intent. Test
coverage is substantial (`tests/prohibition-enforcement.test.cjs`, 1336 lines), and all six
contributing issues (#644, #1259, #1278, #1279, #1346, #1906) are closed as COMPLETED on
GitHub.

**The blocker.** This ADR names its own precondition for becoming binding, in its own words:
"on accepting this ADR, replace ADR-550's 2026-06-12 / #1259 / #1279 / #1346 / #1278
enforcement addenda with a one-line pointer to this ADR ... Until that is agreed, 550's
addenda remain authoritative and this ADR is non-binding." That dedup has not happened.
Direct read of `docs/adr/550-spec-phase-probe-contract.md` confirms all four named addenda —
"Addendum (2026-06-12; updated 2026-06-15)", "Addendum (2026-06-15, #1279)", "Addendum
(2026-06-21, #1346)", and "Addendum (2026-06-15): optional `check` descriptor ... (#1278)" —
remain in ADR-550 in full, verbatim; none has been collapsed to a pointer. A later, separate
addendum in ADR-550 (2026-06-22, from #1607) does cross-reference ADR-1606 for the
*recall/representation-side* "Alternatives considered," but that is additive scaffolding, not
the enforcement-addenda dedup this ADR names as its own condition — the four target addenda
are untouched by it. No commit, PR, or tracked issue was found executing the dedup.

**Unblock condition.** Edit `docs/adr/550-spec-phase-probe-contract.md` to collapse the four
named addenda (2026-06-12/2026-06-15 update, #1279, #1346, #1278) into the one-line pointer
this ADR calls for, then flip both ADR-550's cross-reference and this ADR's Status in the
same PR. To check in minutes: grep `docs/adr/550-spec-phase-probe-contract.md` for
`## Addendum (2026-06-12`, `#1279`, `#1346`, and `#1278` — if those headings still carry the
full addendum text rather than a one-line pointer, the precondition remains unmet.

## Context

ADR-550 D4 originally specified the `test` tier as a "hard gate in both interactive and
autonomous modes" but left the *mechanism* unspecified. As the prohibition probe shipped
(#644) and grew an enforcement producer (#1259→#1346), a set of load-bearing decisions had
to be made that are not derivable from the contract alone:

- A generic producer cannot *trust* that a wired check actually fails on a violation. Caller
  attestation (`failFirst: true`) is unfalsifiable at verify time and was a fake-green hole.
- A generic producer cannot *synthesize* a violation for an arbitrary check, so proving
  fail-first requires an author-supplied known-bad subject.
- "The test went red" is not proof the *content* caused the red — an env-var-triggered or
  load-crash red forges a green.
- The check descriptor must round-trip through the **flat** `parseMustHavesBlock` shared by
  `truths`/`artifacts`/`key_links` without a parser rewrite that would regress those readers.
- A missing, partial, or un-provable check must **fail closed**, never silently pass — the
  whole point of the tier.

## Decision

1. **No path greens on attestation alone.** A `test`-tier prohibition reaches
   `passed`/`green` **only** when its wired check (a) genuinely, **non-vacuously** runs and
   passes AND (b) is independently **machine-proven fail-first** against a known violation.
   The enforcement producer (`runProhibitionEnforcement` in
   `src/prohibition-enforcement.cts`) computes this as
   `passed = proof.provenFailFirst === true && run.passed === true` and only then emits
   non-empty `enforcementEvidence`. The disposition step
   (`dispositionForProhibition` in `src/probe-core.cts`) then greens a `test`-tier item
   **only** on that non-empty evidence; every other outcome — missing check, partial/invalid
   descriptor, can't-prove, throws, times out, no violation source, passes-on-violation,
   `located:false` — yields `{status:'unverified', flagged:true}` (`gaps_found`, never green)
   in both interactive and autonomous modes. (The green rule and the fail-closed default are
   intentionally split across the producer and the disposition so the disposition can fail
   closed even when the producer never ran.) This is the standing form of ADR-550 D4's
   guarantee.

2. **Two wired-check kinds, one producer.** The producer accepts exactly two mechanisms:
   - **`node-test`** — a `node --test` negative test that reports a real, **non-vacuous**
     failing test. Two distinct vacuity guards apply: `isNonVacuousNodeTestRed` rejects a
     load-crash red by requiring a failing test **named distinctly from the target file**;
     `isNonVacuousNodeTestPass` rejects the empty-file "0 tests = pass" forgery on the
     pass side. (Both live in `src/prohibition-enforcement.cts`.)
   - **`lint-rule`** — a lint/AST rule run through the project flat config as
     `eslint --format json` and filtered by `ruleId` (so `local/*` plugin rules load; a bare
     `--rule` cannot). Invoked via `process.execPath` against the resolved eslint CLI, not a
     bare `eslint` binary. Dogfooded on the in-tree `local/no-source-grep` rule.

3. **Machine-proven fail-first via an author-supplied violation fixture.** Before a clean
   pass can green, the producer runs the wired check against a **known-bad subject** and
   requires RED. The subject is sourced from `violationFixture`:
   - `lint-rule`: a file whose content violates `rule`; the rule id must appear in the JSON
     report (the rule must have teeth).
   - `node-test`: injected into the child as `GSD_PROHIB_SUBJECT=<violationFixture>`; the
     negative test reads that env var to locate its subject and must go RED against it.
   - **Absent fixture → fail closed** (never attestation). Existence is checked
     (`fs.existsSync(path.resolve(cwd, fixture))`) before spawning, symmetric with the
     lint-rule path which fail-closes on a `< 1`-file result.

4. **Causation control (opt-in).** A node-test red proves nothing about *why* it is red. An
   optional `cleanFixture` runs the same negative test a second time with
   `GSD_PROHIB_SUBJECT=<cleanFixture>` and requires **non-vacuous GREEN**
   (`isNonVacuousNodeTestPass`) — so fail-first is proven only when the check is **RED on the
   violation AND GREEN on the clean subject** (content-dependent red). ~~Opt-in, not mandatory:
   absent `cleanFixture`, behaviour matches the pre-#1346 zero-authoring compose path and the
   "reds because the env var is set" case stays a documented residual for that one author's
   check.~~ **MANDATORY for the node-test kind as of #1906 (2026-07-03) — absent `cleanFixture`
   the node-test is un-provable (fail-closed), never proven on the violation alone; see the #1906
   addendum below.** The lint-rule kind needs no analog (its subject *is* the linted file; no
   env-var indirection).

5. **Deterministic locate via five flat scalars — never a nested object.** The wired-check
   descriptor is authored at spec-phase and projected onto the `must_haves.prohibitions`
   item as **five flat scalar keys**: `check_kind`, `check_target`, `check_rule` (lint-rule
   only), `check_violation_fixture`, `check_clean_fixture` (optional). A nested `check: {}`
   object is **rejected**: `parseMustHavesBlock` is a flat parser and its
   `reconstructFrontmatter` serializer is lossy for nested object-lists, so a nested shape
   would mangle the round-trip and risk the shared `truths`/`artifacts`/`key_links` readers.
   `projectProhibitions` (in `src/probe-core.cts`) emits the scalars only for a well-formed
   descriptor; `descriptorFromProjection` (in `src/prohibition-enforcement.cts`) reads them
   back into the `{ kind, target, rule? }` `CheckDescriptor`. A prohibition authored with all
   five scalars machine-proves fail-first and greens **end-to-end through the projection with
   zero hand-authoring**.

6. **`failFirst` is demoted, not removed (FF-08).** The `CheckDescriptor.failFirst` field is
   kept for route-JSON backward-compat but **demoted to a non-authoritative hint** — the
   machine prover supersedes it. Removal was rejected (breaks the route-JSON shape mid-
   migration); demote-and-ignore satisfies "no path greens on attestation."

7. **The contract is the CI surface, not the LLM.** Per ADR-550 D5, CI deterministically
   tests parse/validate, the projection round-trip (fast-check property + CHK-03), the
   fail-closed guards (CHK-06), and backward-compat (CHK-07) — never the model's judgment.
   This ADR adds no CI claim over LLM behaviour.

## Consequences

- **Positive:** the verify-time enforcement subsystem has a single architecture-of-record
  instead of five addenda on a spec-phase ADR; the "never a silent pass" guarantee is stated
  once, completely, with its fail-closed defaults; the descriptor's flat-scalar shape and its
  rationale are findable without reading the frontmatter parser.
- **Costs:** one more ADR to keep in sync with `src/prohibition-enforcement.cts`; the dedup
  against ADR-550's addenda must actually be executed at PR time or the repo carries two
  homes for the same decision (the explicit risk this ADR is meant to *remove*).
- **Open conventions (renamable at review, zero live consumers):** `GSD_PROHIB_SUBJECT` and
  the `check_violation_fixture`/`check_clean_fixture` scalars have **no in-tree `node-test`
  consumer** yet (the only live dogfood is the lint-rule `local/no-source-grep`; node-test
  fail-first is exercised only by synthetic temp fixtures). A rename or an argv-for-env-var
  swap is a mechanical zero-migration find/replace — surfaced here for the maintainer to
  settle at review, exactly as #1278/#1279 were. (Hyrum's Law: this ADR deliberately marks
  them as not-yet-depended-on so they remain changeable; the *scalar key names emitted by
  `projectProhibitions` in shipped code* are, by contrast, already a contract.)
- **Boundary held:** canon security/compliance is referred to `/gsd:secure-phase` + eslint,
  not minted here (ADR-550 D6); this ADR governs only bespoke product/values test-tier
  enforcement.

## Alternatives considered (rejected & deferred)

Enforcement-side alternatives, each with the standing reason and a re-open condition. *(The
recall/representation/packaging-side alternatives — the withdrawn LLM classifier #652, a
deterministic recall engine, a `polarity` field on `truths`, and the deferred dispatcher CLI —
belong to the spec-phase contract and are recorded in ADR-550's "Alternatives considered.")*

- **A nested `check: {}` descriptor object — REJECTED.** `parseMustHavesBlock` is a flat
  parser and `reconstructFrontmatter` is lossy for nested object-lists, so a nested shape
  would mangle the round-trip and could regress the shared `truths`/`artifacts`/`key_links`
  readers. Hence the five **flat scalar** keys (Decision 5). *Re-open only if*
  `parseMustHavesBlock` is replaced with a structured parser (its own ADR, with the full
  shared-reader regression surface).
- **An inline producer-written violation snippet — REJECTED.** To machine-prove fail-first the
  violation is an author-supplied **fixture path** (`check_violation_fixture`), not source the
  producer writes inline, which would bake rule-specific source into a generic producer
  (Decision 3).
- **`failFirst` caller attestation as authoritative — REJECTED → DEMOTED (FF-08).** Trusting
  the caller's `failFirst: true` was an unfalsifiable fake-green hole; the machine prover
  supersedes it and the field is demoted to a non-authoritative hint kept only for route-JSON
  backward-compat (Decision 6). Outright removal was also rejected (breaks the route-JSON
  shape mid-migration).
- **Mandatory causation control — REJECTED in favour of opt-in.** Requiring every node-test
  prohibition to ship a `cleanFixture` would regress the zero-authoring compose path and
  hard-gate every existing descriptor without one; the control is opt-in (Decision 4), leaving
  one documented residual rather than breaking working checks. **↳ SUPERSEDED 2026-07-03 (#1906)
  — see the addendum below.** The blast-radius premise no longer holds: there is **no in-tree
  `node-test` consumer** (Consequences, "Open conventions"), so making the control mandatory
  hard-gates *zero* existing checks. Decision 4 is now mandatory for the node-test kind.

## Addendum (2026-07-03, #1906) — node-test causation control is now MANDATORY (supersedes Decision 4's opt-in)

Decision 4 made the `cleanFixture` causation control **opt-in** to avoid regressing the #1314
zero-authoring compose path. That trade-off left a Goodhart hole open **by default**: a node-test
that omits `cleanFixture` is proven fail-first on the violation alone, so a deceptive
content-independent negative test — one that reds merely *because* `GSD_PROHIB_SUBJECT` is set,
ignoring the subject's CONTENT (`assert.ok(!process.env.GSD_PROHIB_SUBJECT)`) — passes the proof.
The proof's observed signal (RED) thus diverges from its target (RED *caused by content*), and the
divergence is the **default**, not an edge case an author opts into.

**Decision (owner ruling on #1906, 2026-07-03):** for the `node-test` kind the causation control is
**required**. A node-test descriptor that omits `cleanFixture` is treated as **un-provable**
(fail-closed) — never accepted under the weaker violation-only proof. When a clean fixture is
present, fail-first is proven exactly as before (RED on the violation subject **AND** non-vacuous
GREEN on the clean subject); a deceptive content-independent test reds on the clean subject too, so
the control fails and the proof does not pass.

- **Why the opt-in's rationale no longer applies.** Decision 4 / the rejected-alternative above kept
  the control opt-in to avoid hard-gating "every existing descriptor without one." Per this ADR's own
  Consequences ("Open conventions … no in-tree `node-test` consumer"), **there are none** — the only
  live dogfood is the lint-rule `local/no-source-grep`; node-test fail-first is exercised only by
  synthetic temp fixtures. So the mandatory control hard-gates **zero** real checks today; its cost is
  paid only by future node-test authors, who now must supply a clean control subject to earn a green.
- **Scope — node-test only.** The `lint-rule` kind is unchanged (byte-identical): its subject *is* the
  linted file, with no `GSD_PROHIB_SUBJECT` indirection, so the "reds because the env var is set" gap
  cannot exist there. Net effect on D4's disposition is unchanged — every miss/fail/**un-provable**
  still hard-gates; this only *tightens* what counts as proven.
- **Breaking change (Hyrum).** A previously-green node-test prohibition with no clean fixture now
  hard-gates. Disclosed as breaking with the ~zero in-tree blast radius noted above. `cleanFixture`
  stays optional at the *type* level (it rides both kinds; the lint-rule kind never uses it) but is
  *required by the node-test prover*.
- **Mechanism.** `defaultProveFailFirst`'s node-test branch in `src/prohibition-enforcement.cts`:
  `const clean = check.cleanFixture; if (!clean) return { provenFailFirst: false, … }` before the
  existence + non-vacuous-GREEN control. Compiled by `build:lib`. ADR-550's 2026-06-21 (#1346)
  addendum "Why opt-in, not required" is superseded to match.

## Cross-references

- **ADR-550** — spec-phase probe contract; this ADR consolidates its enforcement addenda, and
  ADR-550 holds the recall/representation/packaging-side rejected alternatives.
- **ADR-857** — section *"Verification substrate vs. plug-in tier (the predicate boundary)"*
  (decision #6): the verifier↔predicate contract lands on the **core verify rail**
  (non-toggleable), never in `capabilities/`; this seam is its concrete enforcement instance.
- **`gsd-core/references/prohibition-probe.md`** — the portable runtime reference.
- **`docs/how-to/resolve-prohibition-findings.md`** — user-facing resolution guide.
- Code: `src/prohibition-enforcement.cts`, `src/probe-core.cts` (`projectProhibitions`),
  `gsd-core/workflows/verify-phase (retired in #1892)`. Issues: #644, #1259, #1278, #1279, #1346, #1906.

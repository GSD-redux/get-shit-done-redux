# ADR-1820: Spec-Optional Predicate Rail — the Spec-Section Detection Module, the fallback toggle, and the SPEC↔probe precedence contract

- **Status:** Accepted
- **Date:** 2026-07-04
- **Issue:** [#1820](https://github.com/open-gsd/gsd-core/issues/1820) — `approved-feature` (ADR-857 Phase 6, predicate-rail exception 857:138)
- **Relationship to prior ADRs:** This does NOT restate ADR-857 (predicate generation is core substrate, not an off-by-default Capability), ADR-550 (the spec-phase probe contract + the `must_haves.prohibitions` projection), or ADR-1606 (the verify-time enforcement seam). It documents the *new architectural surface* #1820 introduces on top of them: a new Module seam, a new config toggle, and the SPEC-supplied-vs-probe-derived precedence/authoring contract. 857:138 pre-approved the *policy* of wiring the probe family onto the core rail (settled 2026-06-12); it does not itself document this module, toggle, or gate, which were designed afterward.

## Context

The edge-probe and prohibition-probe families surface a phase's unwritten edges and must-NOTs. Before #1820 they ran **only** in `spec-phase` (Step 5.5 / 5.6), so their value reached the verifier **only when a phase authored a SPEC.md**. But the verifier reads `must_haves` from **PLAN.md** frontmatter (`verify-phase` (workflow, retired in #1892)), not from SPEC.md — SPEC.md is only an optional source `plan-phase` lifts from. A phase planned without a SPEC therefore shipped with an empty predicate set and the probes' reach was lost. Per the load-bearing premise *verifier reach = spec reach*, that is a silent coverage hole precisely where a spec is thinnest.

The fix wires the probe generators into `plan-phase`'s `must_haves` authoring as a **spec-optional fallback**: when a section is absent (no SPEC, or a SPEC that omits/empties that section), the fallback runs the probe and authors the predicates directly into PLAN.md. Deciding *whether a section was supplied* requires detecting the SPEC's `## Edge Coverage` / `## Prohibitions (must-NOT)` sections and counting their resolved rows. That detection first lived as ad-hoc `awk` inline in the workflow body, which hard-coded the header strings at the call site and hand-rolled markdown-table row counting — brittleness that produced two real bugs (an exact `^## Prohibitions$` anchor that missed the canonical `## Prohibitions (must-NOT)` heading, and a single-table row-counting assumption). Centralizing the detection made the knowledge testable and shared — and created a new Module seam, which is what makes this an ADR-worthy decision (contributor-standards: *"an ADR is required when a decision introduces a Module seam that other code will depend on"*).

## Decision

### 1. A new `spec-section` Module seam owns "did the SPEC supply section X?"

`src/spec-section.cts` (compiled to the gitignored `gsd-core/bin/lib/spec-section.cjs` per ADR-457) is the **single source of truth** for SPEC-section detection. Pure and dependency-free. Locked exported surface:

- `SpecSectionKey` — the logical sections the fallback cares about (`edges | prohibitions`).
- `SECTION_HEADERS` — the canonical, **suffix-tolerant** header matchers (`prohibitions` matches both `## Prohibitions` and `## Prohibitions (must-NOT)`; `edges` matches `## Edge Coverage` and any future parenthetical suffix).
- `SectionStatus` — `{ key, present, dataRows, supplied }`.
- `countSectionDataRows(specText, key)` — pure `specText → { present, dataRows }` (multi-table-robust: a blank/prose line resets per-table state, the `|…|` line before a `|---|` separator is the header row and is never counted).
- `specSectionStatus(specFile, key)` — the disk-reading wrapper.

**Invariants this seam pins:**
- **Supply rule:** `supplied = present AND dataRows > 0`. A present-but-empty section is *not* supplied and triggers the fallback.
- **Suffix-tolerant header contract:** if `spec-phase` renames a heading, update `SECTION_HEADERS` **and** the `templates/spec.md` heading together. The contract is pinned by `tests/spec-section.test.cjs` (both historical bugs are regression-tested).
- **Fail-safe:** a missing/unreadable SPEC file resolves to `present:false` / `supplied:false` (fallback fires) rather than throwing.

Ownership boundary: this seam answers *detection only*. It does not run probes, author `must_haves`, or read config — those stay in the workflow body and the existing probe/projection modules. A future third spec-section consumer reuses this seam instead of re-parsing markdown (the extraction Gall's-Law rationale below).

### 2. `workflow.specless_probe_fallback` — a default-ON, disableable policy toggle

The fallback is governed by a new config key `workflow.specless_probe_fallback` (registered in `config-schema.manifest.json` `validKeys`), **default-on**, with a **visible "disabled" marker** when off.

- **Why a toggle exists (Chesterton's Fence):** the prohibition-recall half is an LLM pass with a real per-invocation cost; the toggle is the cost-gate that lets a project opt the fallback *invocation path* out without touching the verifier↔predicate contract.
- **Why default-on:** the probe family is core verification substrate (ADR-857); shipping the fallback default-off would recreate the skippable-gate failure one level up. Default-on keeps the substrate reaching the verifier by default; the visible skip keeps a disabled state honest, never silent.
- **Boundary with ADR-857:66 (ruled, not re-opened):** 857:66 says the probe *generator* is "default-on and non-removable." This toggle governs the **spec-less fallback invocation path**, not the generator or the verifier↔predicate contract (which stay non-toggleable core substrate). The maintainer ruled on #1820 that *857:66 governs spec-phase, not the spec-less fallback* — so a default-on **disableable** toggle over the fallback path is in-bounds. This ADR records that ruling; it does not amend 857:66.

### 3. The SPEC-supplied ↔ probe-derived precedence & authoring contract

- **Section-level precedence — a SPEC-supplied section is never re-run.** The fallback fires **per section**: only for a section that is absent or empty (`supplied === false`). A section the human authored in the SPEC is lifted as-is and never overwritten by the probe. This is section-level, not file-level: a partial SPEC (edges present, prohibitions omitted) runs the fallback for prohibitions only.
- **One serializer, no second producer (Hyrum).** Fallback-authored prohibitions go into the `must_haves.prohibitions` sibling block via the **same `projectProhibitions` serializer** SPEC-lifted prohibitions use — no parallel authoring path, so the verifier↔predicate round-trip contract is unchanged.
- **Fallback predicates are descriptor-less → flagged, never green, never auto-dismissed.** A probe-recalled prohibition authored without a wired `check_*` descriptor disposes `flagged`/`unverified` at verify time (ADR-550 D4/D5 fail-closed default; honest-verifier abstention, #1154) — it surfaces for human resolution, it does not silently pass. Unresolved edges are surfaced as explicit assumptions, never silently dropped. **No-silent-drop equality** holds between the SPEC-lifted and fallback paths.

## Consequences

- **Positive:** the probes' reach no longer depends on a phase authoring a SPEC; SPEC-section detection is testable and shared instead of re-parsed inline; the toggle gives projects a cost-gate without a capability surface; the precedence contract makes "who wins, SPEC or probe?" a documented decision rather than call-site behavior.
- **Cost / Hyrum:** the toggle default-on is an observable behavior change (a no-SPEC phase now emits predicates it previously didn't) — but the honest-verifier's fail-closed abstention keeps it from being a *regression* (descriptor-less fallback predicates flag/abstain, never flip a previously-green phase red). `SECTION_HEADERS` becomes a depended-on surface: renames must move it and `templates/spec.md` together (pinned by test).
- **Deferred (Gall's Law).** The build surfaced a duplicated `_gsd_lib()` runtime-dir resolution idiom shared by the probe shim steps; further centralizing it is deferred, not done. This ADR names the `spec-section` seam as the precedent so the **next** probe-fallback consumer extends an existing seam rather than re-inlining detection — the failure mode a documented seam prevents.

## Cross-references

- **ADR-857** — *Verification substrate vs. plug-in tier (the predicate boundary)*: predicate generation is core, non-toggleable substrate; Phase 6 (Migrate) wires the probe family onto the core rail (857:138). This ADR is that migration's plan-side landing.
- **ADR-550** — spec-phase probe contract; the `must_haves.prohibitions` projection (`projectProhibitions`) and the fail-closed disposition this rail reuses unchanged.
- **ADR-1606** — the verify-time enforcement seam that consumes the authored predicates.
- **ADR-457** — `src/*.cts` → gitignored `bin/lib/*.cjs` build seam.
- **CONTEXT.md** — *Spec-Section Helper Module* (the greppable module predicate).
- **Code / prompts:** `src/spec-section.cts`, `gsd-core/workflows/plan-phase.md` (Step 7.95 + the `<downstream_consumer>` Otherwise branches), `gsd-core/references/specless-probe-fallback.md` (the protocol), `gsd-core/references/planning-config.md` (the toggle), `gsd-core/bin/shared/config-schema.manifest.json`. Tests: `tests/spec-section.test.cjs`. Issue: #1820.

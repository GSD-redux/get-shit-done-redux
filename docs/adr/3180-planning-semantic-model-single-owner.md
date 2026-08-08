# ADR-3180: Planning Semantic Model — Single Owner per Derivation

- **Status:** Accepted (Phase 0 — ADR only; locks the contract Phases 1–5 execute against. No production code lands in this PR.)
- **Date:** 2026-08-07
- **Issue:** [#3180](https://github.com/open-gsd/gsd-core/issues/3180) is the **scope authority** (`epic` + `approved-enhancement` + `type: chore`), which is why this ADR carries its number. [#3182](https://github.com/open-gsd/gsd-core/issues/3182) is the Phase-0 tracking sub-issue this PR closes — the epic stays open until the final phase merges. This follows [ADR-3128](3128-adaptive-runtime-evidence.md), whose filename likewise tracks its scope-authority issue while its PR referenced a separate docs sub-issue.
- **Supersedes:** nothing
- **Relationship to prior work:** extends [ADR-2121](2121-phase-identifier-parsing-consolidation.md), which consolidated phase-identifier **syntax** and proved the mechanism (`scripts/lint-phase-id-drift.cjs` reports 0 independent re-derivations). This ADR applies the same mechanism one layer up, to the **semantics** of the `.planning/` model. Distinct from [#1879](https://github.com/open-gsd/gsd-core/issues/1879) (absent-vs-corrupt across I/O read paths), [#2143](https://github.com/open-gsd/gsd-core/issues/2143) (the document-parsing layer beneath), and [#3051](https://github.com/open-gsd/gsd-core/issues/3051) (why the suite did not catch these).

Symbol names are the durable anchors throughout. Line references, where given, are as of `next` @ `cbd180c5c` and will drift.

## Context

ADR-2121 consolidated what a phase is *called*. Nothing consolidated **which phases exist, which milestone owns them, which are done, and how many plans are live.** Those derivations are re-implemented independently at every call site.

### The divergent surface

In every row a **correct implementation already exists beside the broken one.** These are not gaps in knowledge; they are fixes that landed on one copy.

| Derivation | Copies | Canonical (correct) | Divergent |
|---|---|---|---|
| Milestone windowing | 3 | `currentMilestoneRawRanges::computeSectionEnd` — the only copy carrying a "keep in sync" comment | `extractCurrentMilestone::computeSectionEnd`; an undocumented inline copy in `getMilestonePhaseFilter`'s `versionOverride` branch |
| Phase enumeration | 4 | `cmdRoadmapAnalyze` — scopes via `extractCurrentMilestone` **and** filters sentinels | `cmdProgressRender`, `cmdStats`, `cmdPhasesList` |
| Phase completion | 2, disagreeing | `cmdPhaseComplete` — calls `readVerificationStatus` unconditionally | `buildPhaseCompletionProjection` — gates it behind `planCount > 0` |
| Live-plan counting | 3 | `scanPhasePlans` — excludes `status: superseded` (#2349) | `cmdFindPhase`; `findPhaseInternal`/`searchPhaseInDir` |
| State field extraction | 2+ | `stateExtractField` consumers carrying the #1760 fallback chain | `cmdStateValidate`; `cmdStateCompletePhase`'s idempotency guard |

The milestone-windowing duplication is verifiable structurally, not just textually: `roadmap-parser.cts` contains **two distinct `computeSectionEnd` function nodes** — `extractCurrentMilestone::computeSectionEnd` and `currentMilestoneRawRanges::computeSectionEnd` — separate definitions with separate call sites, not one function referenced twice.

### The failure mode that hides all of it

Every divergent path returns a **well-formed, plausible value**. None throws, none logs, none returns a sentinel a caller can branch on — the failure and the success are output-identical:

| Path | Returns on failure |
|---|---|
| `extractCurrentMilestone`, truncated window | `phases: []`, `phase_count: 0`, no error |
| `getMilestonePhaseFilter`, empty result | a **pass-all** filter → archives every phase dir on disk |
| `cmdStateValidate` | `{valid: true, warnings: [], drift: {}}`, unconditionally |
| aggregate percent | `100` while plans are outstanding |
| `buildPhaseCompletionProjection` | `not_required`, ignoring a real passing `*-VERIFICATION.md` |

This is why 13 of the 14 defects in the 2026-08-07 sweep were found by a contributor dogfooding downstream rather than by the suite: a test asserting "returns a number" or "does not throw" passes against every row above.

### The derivations are one coupled cluster

`get_impact(extractCurrentMilestone, direction=both, depth=10)` against `next` @ `cbd180c5c` returns risk **CRITICAL** — 200 affected symbols with `total_affected_is_lower_bound: true` and `truncated: true`, spanning 43 distinct `affected_files` and 24 `affected_processes`. The counts are depth- and truncation-sensitive: a shallower query returns fewer files and is not a contradiction. Every symbol this epic names sits inside that single blast radius.

| Symbol | Rating | Direct callers |
|---|---|---|
| `extractCurrentMilestone` | **CRITICAL** | 20 |
| `stateExtractField` | high | **20** |
| `scanPhasePlans` | medium | 11 |
| `getMilestonePhaseFilter` | medium | 10 |
| `buildPhaseCompletionProjection` | low | 3 |

This bounds the decomposition: the phases are **stacked and sequential**, never parallel, because a parallel phase would edit symbols inside a sibling's radius.

> **Correction to #3180's text.** The epic states `stateExtractField` has "five call sites." `find_symbol` reports **20 direct callers**. Phase 5's call-site sweep must be driven from the graph, not from that count.

### The hypothesis is falsifiable, and it held twice

Predicted: fixes land on one copy while siblings stay broken. Confirmed — #1760 fixed 3 of 5 `stateExtractField` sites; #3165's fix provably does not reach #3166's inline copy.

Predicted: new readers arrive carrying new copies. Confirmed — `cmdPhasesList` was found during triage as a fourth unscoped `phasesDir` reader that no issue had reported.

Per `CONTRIBUTING.md`: **One issue = one ADR-or-PRD = one PR.** This ADR is that one file. It ships no production code.

## Decision

Give each semantic derivation a single canonical owner, enforced mechanically the way ADR-2121 enforced identifier syntax, and give every derivation a distinguishable failure signal instead of a plausible default. Six decisions, locked below.

### 1. One canonical owner per derivation; the duplicates are DELETED

The surviving owner per derivation:

Every owner is **named**, with a locked module and signature. Phases consume them verbatim.

| Derivation | Canonical owner (module · symbol) | Deleted |
|---|---|---|
| Milestone windowing | `src/roadmap-parser.cts` · `currentMilestoneRawRanges::computeSectionEnd`, lifted to a module-level export `computeMilestoneSectionEnd` | `extractCurrentMilestone::computeSectionEnd`; the `getMilestonePhaseFilter` `versionOverride` inline copy |
| Phase enumeration | `src/phase-locator.cts` · `listMilestonePhaseDirs` (new export; the Phase Locator Module already owns on-disk phase discovery) | the direct phases-dir reads in `cmdProgressRender`, `cmdStats`, `cmdPhasesList`; the nested `cmdRoadmapAnalyze::isSentinelPhase` closure |
| Phase completion | `src/verification.cts` · `isPhaseComplete` (new export, sited beside `readVerificationStatus`, which it wraps) | the `planCount > 0` gate in `buildPhaseCompletionProjection` |
| Live-plan counting | `src/plan-scan.cts` · `scanPhasePlans` | filename re-derivation in `cmdFindPhase`, `findPhaseInternal`/`searchPhaseInDir` |
| State field extraction | `src/state-document.cts` · `stateExtractField` carrying the #1760 fallback chain | per-site re-derivation at all remaining call sites |

Locked signatures for the two new owners (`ScopedResult<T>` is defined in Decision 2):

**`listMilestonePhaseDirs(roadmapContent: string, phasesDir: string, deps?): ScopedResult<string[]>`**
Applies the milestone window **and** the sentinel filter in that order, and returns the surviving
phase directory names. The sentinel predicate delegates to the existing canonical
`isSentinelPhaseId` in `src/phase-id.cts` — it does **not** re-implement the nested
`cmdRoadmapAnalyze::isSentinelPhase` closure, which is itself a sixth instance of this epic's
divergence class and is deleted by Phase 3.

**`isPhaseComplete(phaseDir: string, deps?): ScopedResult<{ complete: boolean; verification: VerificationStatus }>`**
The single predicate for both the read path (`buildPhaseCompletionProjection`) and the write path
(`cmdPhaseComplete`). It calls `readVerificationStatus` **unconditionally** — there is no plan-count
precondition. A phase with zero plans and a passing `*-VERIFICATION.md` is complete.

**Deleted, not kept in sync by comment.** The "keep in sync" comment on the canonical windowing copy is already in place and already failed; it is evidence the risk was known, not that it was controlled.

*Rejected:* keeping N copies with a parity assertion test. A parity test proves the copies agree *today*; it does not stop copy N+1, and `cmdPhasesList` demonstrates copy N+1 arriving unreported.

### 2. The shared result contract — PROVISIONAL, validated by Phase 1

**Home module — locked.** `SCOPE` and the `ScopedResult<T>` shape live in a **new pure leaf module,
`src/planning-scope.cts`**, exporting nothing else. It follows the `src/phase-id.cts` precedent: pure,
no Node built-ins, no config, no other core dependency, so every consumer above it can import it
without a cycle. Phase 1 creates it.

> Creating a new `.cts` module carries this repo's six-gate ripple — `.gitignore`, eslint config,
> `docs/INVENTORY.md`, the inventory manifest (regenerate **after** `build:lib`, never before, or
> modules are silently dropped), the `CONTEXT.md` **Glossary — Domain modules and seams** entry
> (a PR gate), and `size:baseline`. Phase 1 owns all six.

Every consolidated derivation returns a result carrying a `scope` discriminator drawn from a frozen enum:

```js
const SCOPE = Object.freeze({
  COMPLETE:   'complete',    // computed over the whole intended input
  TRUNCATED:  'truncated',   // input window was cut short
  UNSCOPED:   'unscoped',    // ran without the scoping it required
  UNREADABLE: 'unreadable',  // input absent or unparseable
});

/** @typedef {{ value: T, scope: typeof SCOPE[keyof typeof SCOPE] }} ScopedResult */
```

`ScopedResult<T>` carries the derivation's own payload in `value` (an array for the list-shaped
derivations, an object for `isPhaseComplete`, a nullable string for `stateExtractField`) plus the
`scope` discriminator. Nothing else is added to the shape — a caller needing more asks for an
amendment rather than widening it locally.

`COMPLETE` with zero items is a **real answer** — a freshly-declared milestone genuinely has no phases. `TRUNCATED`/`UNSCOPED`/`UNREADABLE` with zero items is a **non-answer**. Today those are the same value, and that identity is the epic.

The enum is frozen and asserted on directly (`result.scope === SCOPE.TRUNCATED`). It is **not** a message string: `CONTRIBUTING.md` § *Prohibited: Raw Text Matching on Test Outputs* requires a typed IR and forbids `assert.match` against rendered prose.

> **This contract is provisional until Phase 1 validates it.** Phase 1 (live-plan counting) is the first and smallest real implementation. If the contract does not fit, **this ADR is amended before Phase 2 begins** — the contract is not worked around in code. Amendments are recorded in the Amendments section below. This is a deliberate Gall's Law concession: a five-derivation contract locked before a single consolidation exists is a design that has never met production.

*Rejected:* a boolean `ok`/`degraded` — rows TRUNCATED/UNSCOPED/UNREADABLE need three distinct caller responses, and a boolean recreates the collapse this epic removes. *Rejected:* throwing instead of returning a scope — these paths are read during normal progress rendering, and throwing converts a display degradation into a command failure.

### 3. Two-tier change policy (Hyrum's Law)

`getMilestonePhaseFilter`'s pass-all degrade is **documented in its own comment** as deliberate and safe ("over-inclusive, never under-inclusive"). That is not an accidental behavior someone latched onto — it is a written promise. Changing it needs an explicit policy:

- **Tier 1 — internal function contracts** (the five owners and their duplicates). Freely changed; duplicates deleted. The consumers are gsd-core's own call sites, enumerable from the graph. No deprecation cycle.
- **Tier 2 — observable command output.** These reach downstream projects that **cannot be enumerated**. Every Tier-2 change requires an explicit breaking-change call-out in its PR, a `.changeset/` fragment, and a `docs/` update. The complete list, by phase:

  | Phase | Command surface | Output change |
  |---|---|---|
  | 1 | `phase find` (`cmdFindPhase`, `findPhaseInternal`/`searchPhaseInDir`) | a phase whose plans are all `status: superseded` reports zero live plans, not a positive count |
  | 2 | `roadmap analyze`, `roadmap get-phase` | a truncated window stops reporting `phase_count: 0` as if it were a real empty; `milestone complete` stops pass-all archiving on a truncated window |
  | 3 | `query progress`, `stats`, `phases list` | `999.*` backlog directories no longer listed as current-milestone phases; aggregate percent stops reading `100` while plans are outstanding |
  | 4 | `init manager` | a zero-plan phase with a passing `*-VERIFICATION.md` reports complete instead of `not_required` |
  | 5 | `state validate` | reports invalid for genuinely invalid documents instead of unconditional `valid: true` |

  This list is **contingent on Decision 2's contract surviving Phase 1**. If the contract is amended,
  this table is re-derived in the same amendment rather than inherited unchanged.

The pass-all degrade is preserved where it is correct (a genuinely-empty new milestone, `scope: COMPLETE`) and refused where it is destructive (a truncated window, `scope: TRUNCATED`). Decision 2's contract is what makes that distinction expressible; without it the code cannot tell the two apart, which is exactly why the degrade is dangerous today.

**Phase 5 is the sharpest Tier-2 change in the epic**: `state validate` moves from unconditionally `valid: true` to able to fail, which will surface pre-existing invalid STATE.md documents in downstream CI that currently passes. That is the intended outcome — a gate that cannot fail is worse than no gate — but it ships with an explicit warning.

### 4. The anti-divergence contract — structural guard PLUS behavioral identity test

Each derivation ships a `scripts/lint-<derivation>-drift.cjs` guard modelled on the five existing precedents (`lint-phase-id-drift.cjs`, `lint-package-identity-drift.cjs`, `lint-shell-command-projection-drift.cjs`, `lint-table-schema-drift.cjs`, `check-alias-drift.cjs`), reporting **0 independent re-derivations**, plus a matching identity guard test.

Two constraints are locked, both consequences of Goodhart's Law — "0 re-derivations" is a measure about to become a target:

**(a) Guards discover call sites by whole-repo scan, never by an allowlist of known files.** An allowlist-driven guard measures "re-derivations in files we remembered to list." `cmdPhasesList` is the proof: a guard scanning only the three *reported* unscoped readers would have reported 0 while a fourth existed.

**(b) The structural guard and the behavioral identity test are both required, and neither alone is sufficient.** The lint is gameable by indirection — route a re-derivation through a wrapper, a differently-named local, or a test helper, and the count stays 0 while the divergence returns. The identity test is gameable the other way: it only covers the input shapes its author imagined, the fixture-provenance trap `CONTRIBUTING.md` §2371 already names. The lint is the output metric; the identity test is the outcome metric; Goodhart's prescribed defense is to pair them and never report either alone.

**(c) The identity test asserts at the CONSUMER's output, not at the owner's return value.** This closes the one bypass that defeats both (a) and (b) together: a consumer calls the canonical owner — satisfying the lint, since there is no re-implementation, and satisfying an owner-level identity test, since the owner is untouched — and then **post-processes the result locally**, e.g. re-applying its own "exclude superseded" pass after `scanPhasePlans` returns. Divergence is fully restored and both guards stay green.

Therefore each derivation's identity test compares **each consumer's observable output** against the canonical owner's result for the same input, and fails on any difference. Post-filtering a canonical result is then indistinguishable from re-deriving it, which is the correct equivalence: both produce a second answer to a question that is supposed to have one owner. Where a consumer legitimately needs a narrower set, it passes an argument to the owner — it does not filter the owner's output.

*Rejected:* a lint that asserts all sites match a golden regex — it enforces textual sameness, not single ownership, and cannot see semantic divergence (this is ADR-2121 Decision 1's rejected option (C), and it applies unchanged here).

### 5. Migration order — live-plan counting ships BEFORE milestone windowing

**Locked order:** Phase 1 (live-plan counting) → Phase 2 (milestone windowing) → Phase 3 (enumeration) → Phase 4 (completion) → Phase 5 (state field extraction).

Phase 1 before Phase 2 is not a preference. `roadmap.analyze` calls `extractCurrentMilestone` directly, so repairing the window repopulates Route 0's loop and converts #3164 from a silent no-op into a **live misroute that re-executes a closed phase**. The epic states the constraint as "#3165 must not ship ahead of #3164"; since Phase 2 *is* the #3165 repair, Phase 1 must precede it. **This inverts the order the derivations are listed in #3180's own table.**

Phase 3 follows Phase 2 because the enumeration owner must carry the window Phase 2 consolidates. Phases 4 and 5 are order-independent relative to each other but follow the cluster.

### 6. Scope boundaries

**In scope:** the five derivations above; their guards and identity tests; the `scope` contract; boundary coverage per `CONTRIBUTING.md` and at least one test per derivation asserting the path **can** fail.

**Out of scope:** any change to `.planning/` on-disk formats; the document-parsing layer (#2143); the I/O-failure layer (#1879).

**The child defects — stated precisely, because the epic's shorthand is ambiguous.** #3180 says this epic "removes the class, it does not gate the instances." *Does not gate* means the epic does not wait on them and does not take responsibility for closing them. It does **not** mean the consolidation leaves their symptoms intact — several are *subsumed* as a direct consequence of giving the derivation one owner, because the divergent copy that produced the symptom ceases to exist:

| Phase | Subsumes | Why unavoidable |
|---|---|---|
| 1 | #3164 | routing the plan count through `scanPhasePlans` **is** the superseded-exclusion fix |
| 2 | #3165, #3166 | deleting the divergent windowing copies removes both the truncated-window report and the pass-all archive degrade |
| 3 | #3167, #3161 | one enumeration carrying the sentinel filter removes the backlog-dir listing and the `100`-percent aggregate |
| 4 | #3168 | deleting the `planCount > 0` gate **is** that defect's fix |
| 5 | #3162 | routing `cmdStateValidate` through the fallback chain **is** that defect's fix |

Each phase's PR **names** the child issues it subsumes and records the evidence that the symptom is gone. It does **not** unilaterally close them: #3180 explicitly declined ownership of the instances, so whether a subsumed issue is closed, re-scoped, or left open for its own regression test is the maintainer's call at merge time, made with the evidence in front of them. The remaining child defects (#3169, #3170, #3171, #3174, #3156) are **not** touched — they sit in adjacent parse/format paths this epic does not consolidate — and stay independently actionable.

Recording the subsumption explicitly because both silences are failures: a phase that demonstrably removes a defect's symptom while claiming to change nothing is a shipped lie, and a phase that closes an issue the epic disclaimed is scope it never had. Naming the effect without claiming the disposition is the only honest position available here.

**Scope note on Phase 5.** State field extraction is *not* one of #3180's seven "Done when" items — the epic describes it in evidence as "a fifth instance of the same shape" and lists #3162 among the out-of-scope child defects, while its Goal ("one canonical owner per semantic derivation") covers it. That inconsistency was surfaced during planning and resolved by maintainer decision to include it. #3180's Done-when list should be amended to match, or Phase 5 reads as unclaimed scope.

## Consequences

**Positive.** "Fixed on one copy, missed on the siblings" becomes unrepresentable for five derivations. `phase.complete` succeeding while `init.manager` reports incomplete becomes structurally impossible rather than merely fixed. Failure paths stop being output-identical to success, so the suite can assert on them and the class of bug that required downstream dogfooding to find becomes detectable in CI.

**Negative / accepted costs.** Five new `scripts/` files, which ship in the npm package and installer (inventory and manifest ripples per phase). One new `.cts` module (`src/planning-scope.cts`) carrying the full six-gate ripple in Phase 1. Tier-2 output changes will break downstream consumers parsing current command output — deliberately. Phase 2 carries a CRITICAL blast radius and cannot be de-risked by slicing further without breaking the derivation in half. The stacked ordering means the epic cannot be parallelized, so wall-clock is the sum of five phases.

**Risks.** The contract is validated by exactly one consolidation (Phase 1) before four more build on it; the amendment path in Decision 2 is the mitigation. The guards cannot see re-derivation through dynamic dispatch; the identity tests are the backstop, and they only cover the shapes they were written for.

## Alternatives considered

1. **One mega-PR consolidating all five.** Rejected — 200+ affected symbols in a single reviewable unit, `gsd-test` failures unattributable to a derivation, and a violation of one-concern-per-PR.
2. **Fix the 13 child defects individually, no consolidation.** Rejected — that is the status quo whose failure mode this epic documents: each fix lands on one copy, and the sweep found a fourth reader nobody had reported.
3. **Consolidate without guards.** Rejected — ADR-2121 demonstrated that mechanical enforcement is what makes consolidation durable. Without a guard, copy N+1 arrives with the next reader.
4. **Design the contract inside Phase 1's PR, skip this ADR.** Rejected — Phases 2–5 all depend on the contract, so it would be set by whatever was convenient in the first code PR, with no reviewable design step. (Offered during planning and declined by the maintainer.)
5. **Per-derivation bespoke result shapes instead of one `scope` contract.** Rejected — five shapes inside one coupled blast radius reintroduces the divergence one level up.

## Software laws applied

Cross-referenced via `/skills-from-the-artificer`. Four fired; two materially changed this ADR.

- **Gall's Law — changed the design.** A five-derivation contract locked before any consolidation exists is a complex system built from scratch. Mitigated by Decision 2's provisional status plus the amendment path, and by sequencing the smallest, lowest-risk derivation (`scanPhasePlans`, complexity 3) first so the contract meets production before four phases depend on it.
- **Goodhart's Law — changed the design.** "0 independent re-derivations" is a measure becoming a target, gameable by indirection or by an allowlist-scoped scan. Produced Decision 4's two locked constraints: whole-repo discovery, and a paired structural + behavioral metric.
- **Hyrum's Law — confirmed, and sharper than expected.** The pass-all degrade is documented as intentional in its own comment, so this is a written promise being revoked, not an accident being corrected. Produced Decision 3's two-tier policy. This mirrors ADR-2121 Decision 2, which invoked the same law for `normalizePhaseName`'s CRITICAL radius.
- **Postel's Law** — the epic's own stated lens ("Postel / fail-loud"). The defect is not leniency but leniency with no signal that it engaged. Decision 2 makes the degrade *decidable* rather than removing it.

Considered and not applicable: `choose-boring-technology` (no new dependency; five in-repo guard precedents), `conways-law` (no ownership boundary at stake), `zawinskis-law` (scope grew by one phase by explicit maintainer decision, not creep).

## Cross-references

- [ADR-2121](2121-phase-identifier-parsing-consolidation.md) — the proven precedent this extends
- [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) — the document-parsing layer beneath
- `scripts/lint-phase-id-drift.cjs` — the guard pattern Decision 4 models
- `CONTRIBUTING.md` § *Prohibited: Raw Text Matching on Test Outputs* — why `scope` is a frozen enum
- `CONTRIBUTING.md` § *Fixture provenance (#2371)* — why the identity test alone is insufficient
- Phase sub-issues: [#3183](https://github.com/open-gsd/gsd-core/issues/3183), [#3184](https://github.com/open-gsd/gsd-core/issues/3184), [#3185](https://github.com/open-gsd/gsd-core/issues/3185), [#3186](https://github.com/open-gsd/gsd-core/issues/3186), [#3187](https://github.com/open-gsd/gsd-core/issues/3187)

## Amendments

### Amendment 1 — Phase 1 (#3183) validation: the boundary between Phases 1 and 3 was mis-cut

Decision 2 marked the contract provisional and required amendment before Phase 2 rather than a
workaround in code. Phase 1 exercised it and the contract itself **held** — `SCOPE` needed no
change. What did not hold was the **phase boundary**.

**What Phase 1 found.** Building the Decision 4(a) whole-repo guard — the one that may not use a
file allowlist — turned up **26 live-plan re-derivations across 9 files**. The epic scoped this
derivation at **3 copies**. Per-site triage classified them 21 true re-derivations, 2 asking a
genuinely different question, 2 dead.

**Why the boundary was wrong.** `commands.cts`'s `cmdProgressRender` re-derives *both* enumeration
(assigned to Phase 3) *and* plan counting (Phase 1), on adjacent lines. So DW4's "no caller
re-derives it from filenames" was **unsatisfiable within Phase 1's original file scope** — Phase 1
would have shipped failing its own acceptance criterion while Phase 3 inherited half a derivation.

**Amended scope (maintainer decision).** Phase 1 owns **every** live-plan-counting re-derivation
repo-wide. **Phase 3 narrows** to milestone-window + sentinel-filter enumeration only; its files are
already plan-count-clean when it starts, and its own drift guard inherits a green baseline.

**Two consequential changes to Decision 1's owner surface:**

1. **`scanPhasePlans` gains `allPlanFiles`** (every plan on disk, *pre*-supersession) alongside
   `planFiles` (the live set). `verify.cts` conflated two questions in one loop — numbering-gap
   detection legitimately wants every file on disk, pairing wants the live set. The fix is for the
   owner to answer both explicitly, not to exempt the caller. Single ownership is preserved; the
   owner simply stopped under-serving. Additive — no existing field changed.
2. **`findOrphanSummaries` joins `findUnsummarizedPlans`** in core-utils, sharing the same
   `summaryCandidates` rule. `verify.cts` needed the inverse question (summaries with no plan) and
   had no canonical primitive, so it had hand-rolled one — a third pairing rule of exactly the kind
   Decision 1 exists to prevent.

**Exemptions are by documented reason, never by file allowlist** (Decision 4(a)). Two sites are
exempt, each carrying an inline comment stating the question it actually asks: `audit.cts`
`scanQuickTasks` checks one quick task's own directory for a single completion record, and
`gsd2-import.cts` `readTasksDir` reads a foreign GSD-2 `tasks/` layout during a one-time import.
Neither is a `.planning/` phase directory.

**Decision 3's Tier-2 table is re-derived for Phase 1**, per its own contingency clause. Beyond the
superseded-plan change, the migration also corrects: phases on the post-#3139 **nested `plans/`
layout** (previously counted as zero by every migrated site), **loosely-named plan files**, and
**stray summaries** that inflated completion. The sharpest is `phase.cts`'s `cmdPhasePlanIndex`,
which feeds execute-phase **wave scheduling** — it was scheduling `status: superseded` plans into
waves and reporting zero plans for nested-layout phases.

**Regression caught during migration, recorded because it is a trap for Phases 2–5:** passing the
superseded-filtered `planFiles` into `describeNonCanonicalPlans` made a superseded-but-correctly-named
plan report as a naming violation — the diagnostic reads non-membership as a defect. It takes
`allPlanFiles`. The general rule: a **diagnostic about file naming** wants the physical set; only a
question about outstanding *work* wants the live set. Later phases must make that choice explicitly
per call site rather than swapping in `planFiles` mechanically.

### Amendment 2 — Phase 2 (#3184) validation: the contract held; the copy count was low again

Decision 2's contract needed **no change** for its second consumer: `SCOPE`'s four values covered
every row of the windowing derivation's behavior table, including the two rows the epic's text does
not distinguish (a free-form legacy ROADMAP with no versioned milestones is `COMPLETE`, not
`UNSCOPED` — whole-document genuinely *is* the milestone there). Phase 2 adds no member and changes
no semantics. `src/planning-scope.cts` needed no edit, so Phase 2 carries no `.cts` six-gate ripple.

**What Phase 2 found.** The epic and this ADR both scope milestone windowing at **three** copies, all
inside `roadmap-parser.cts`. Building the Decision 4(a) whole-repo guard found **two more**, in a
different module and one function down: `state.cts` `buildStateFrontmatter` and `syncStateFrontmatter`
each hand-roll `^#{1,3}\s+(?!Phase\s+\S).*${escapeRegex(version)}` to answer "is this milestone
bounded to a versioned ROADMAP heading" — the heading-location half of the derivation, byte-identical
to each other. This is Phase 1's finding repeating with a different derivation: **the epic's copy
counts are a lower bound derived from the reported issues, and the whole-repo guard is what makes them
real.** Both sites now call the owner's `isMilestoneBoundedInRoadmap`, which is a straight
consolidation of the two identical `state.cts` regexes onto `locateMilestoneHeadings` with **no
behavior change** — which is all it should ever have been.

**A boundary tightening was tried and reverted.** A first pass at `locateMilestoneHeadings` swapped its
`\b` version-token boundary for the stricter `(?![\w.-])` used by `isMilestoneShippedInRoadmap`
(#2562), reasoning that `v2.0` should not match inside `v2.0.1` anywhere windowing happens. That broke
`extractCurrentMilestoneScoped`'s #730 contract: a milestone STATE of `v8.0` legitimately selects the
`## v8.0-B …` active sub-milestone heading over a closed `v8.0-A` sibling (`0` is a word character, `-`
is not, so `\b` matches; `(?![\w.-])` does not, because `-` is in its excluded set). `\b` is restored in
`locateMilestoneHeadings`; the stricter boundary stays local to `isMilestoneShippedInRoadmap` and to the
#730 `detailsVersionBoundary`, which answer a narrower question ("is exactly this milestone shipped" /
"which Phase Details section is exactly this one's version token's") than "which heading does this
milestone STATE select." The consolidation itself (three `roadmap-parser.cts` copies plus the two
`state.cts` copies onto one owner) is behavior-preserving.

**A composition-level re-derivation, caught in review of this phase's own diff.** Decision 4(c)
anticipated a consumer post-*filtering* an owner's result. The shape that actually appeared is its
mirror: two sites re-*assembling* a window out of the owner's primitives —
`locateMilestoneHeadings` → pick a heading → `computeMilestoneSectionEnd` → slice — in
`getMilestonePhaseFilter`'s `versionOverride` branch and in `milestone.cts`'s unstarted-phase guard.
Both call the canonical owner at every step, so the drift guard and an owner-level identity test are
both green, and the two compositions had **already diverged** on whether to skip a closed milestone
heading. Decision 4(c) is therefore read to cover **assembly as well as post-processing**: where a
derivation has a composition, the composition is itself an owner. Added as
`sliceMilestoneWindow`; both sites route through it.

**Decision 3's Tier-2 table, re-derived for Phase 2** per its own contingency clause. The row this
ADR predicted lands as written, plus two the prediction did not contain:

| Command surface | Output change |
|---|---|
| `roadmap analyze` | gains a `scope` field. `phase_count: 0` is still emitted verbatim — what changes is that a sibling field now says whether that zero is an answer. Stated precisely because the first draft of this row claimed the count itself changed, which is not what shipped |
| `/gsd:progress --next` Route 0 | `gsd-core/workflows/next.md` treats a non-`complete` scope as scan-failed (warn + fall through to the prior-phase check) instead of looping a phase list the scan could not populate. Without this the new field would be a diagnostic no consumer reads, and #3165's actual symptom — the resume invariant reporting clean because it could not run — would still reproduce |
| `milestone complete` | refuses (unless `--force`) when the window's scope is `TRUNCATED` — the milestone heading was found but its section closes before reaching any phase entries, even though the ROADMAP has phase entries elsewhere — instead of pass-all archiving every phase directory on disk (#3166). `UNREADABLE` and `UNSCOPED` are pre-existing, legitimately-handled states (`missingExplicitVersion` errors where that matters; a missing ROADMAP.md has its own documented graceful path) and are not refused here. |
| `milestone complete` unstarted-phase guard — **not predicted** | the guard scoped its window by STATE.md's `milestone:` field while the filter beside it scoped by the `version` argument; the two could disagree, and the guard under-detected unstarted phases on the destructive path. Both now use the `version` argument. |

**Scope note.** Phase 3 (enumeration) inherits a window layer that is now single-owner and
scope-carrying; its own guard starts from a green windowing baseline, exactly as Phase 1 left plan
counting clean for Phase 3.

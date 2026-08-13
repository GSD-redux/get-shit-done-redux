# ADR-3180: Planning Semantic Model — Single Owner per Derivation

- **Status:** Accepted. Phase 0 shipped this file alone; Amendment 4 (2026-08-08) adds Decision 7 — the normative behavior contract — and lands the guards and the completion-ratio consolidation described there.
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

**(d) A guard's scan surface is every AUTHORED surface that can express the derivation — not `src/`.** Constraint (a) said "whole-repo scan, never an allowlist of known files", and both guards built under it read that as *the whole `src/` tree*. That is itself an allowlist, one directory wide. #1762's second reproduction traced a wrong `30 plans, 24 summaries` figure to a raw `ls -1 … *-PLAN.md | wc -l` snippet inside `gsd-core/workflows/progress.md` — a live-plan re-derivation `lint-plan-count-drift.cjs` reported clean because it was not looking there.

A derivation is re-derived wherever it is *expressed*, and this product expresses these four in two languages: TypeScript under `src/`, and shell embedded in the workflow/command markdown that ships to every runtime. A guard covering one of the two measures half the surface and reports zero. Each derivation's guard therefore declares its scan surface explicitly, and any derivation reachable from the prompt layer is covered there too — `scripts/lint-planning-prompt-drift.cjs` scans `gsd-core/workflows`, `commands`, `agents` and `skills`.

The same constraint applies inward: **a guard's owner FILE is not exempt, only its named canonical FUNCTIONS are.** A whole-file exemption on the owner is constraint (a)'s forbidden allowlist aimed at the one file most likely to grow the next copy, and it did — see Amendment 4.

**(e) Where a surface cannot be consolidated in the same change, the guard ships RATCHETED — never absent.** A derivation expressed in the prompt layer cannot be routed onto its `.cts` owner by an import; it needs a CLI surface to call, which is a phase of its own. The guard still lands, carrying a baseline of the sites that exist at that moment, and follows `scripts/qa-smell-ratchet.cjs`'s invariants exactly:

- a recorded site never fails — it is acknowledged, in writing, with the issue that owns its removal;
- an unrecorded site fails — nobody has looked at it;
- a recorded site that no longer fires **also** fails, so the baseline can only shrink and an acknowledgment can never outlive the thing it describes;
- entries are keyed on `(file, trimmed source text)` plus an occurrence **count**, never on a line number, which churns on every unrelated edit to the same file. The count is what makes a *partial* migration visible: two byte-identical sites in one file would otherwise be one indistinguishable key, so migrating one of them would leave the ratchet green while the other survived. Fewer occurrences than acknowledged fails as a partial migration; more fails as a new copy planted beside an acknowledged one.

*Rejected:* land the guard later, together with the migration. That is the "found it, wrote it down, moved on" posture this epic exists to remove — between the finding and the migration the surface is known-broken *and* unwatched, which is strictly worse than unknown. *Rejected:* a bare `eslint-disable`-style suppression. A suppressed guard and a green guard are indistinguishable at a glance; a ratchet reports its own remaining debt on every run.

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

### 7. The behavior contract — this section is the SOURCE OF TRUTH

Decisions 1–6 answer *who owns* each derivation. They do not say *what the right answer is*, and that omission is why the 2026-08-08 coverage audit could find six copies the epic had never named: a reviewer with no written rule to check a call site against can only ask "does this look like the others", which is how a fifth copy passes review.

This section is that written rule. It is **normative**, and it is what the guards and identity tests of Decision 4 test *against*:

- **Where this section and the code disagree, the code is the defect** — not this section, and not a caller's local expectation.
- A behavior not stated here is **not decided**. It is recorded below as an open question with a forcing function, never resolved silently inside an implementation PR.
- Amending a rule here is an amendment to this ADR (Amendments section), not a code change with a comment.
- Each rule carries a **status**: *Enforced* (owner exists, guard green) or *Required — Phase N* (contract locked, migration outstanding). A *Required* rule is as binding as an *Enforced* one; the only difference is whether the tree satisfies it yet.

#### 7.1 Milestone windowing — *Enforced (Phase 2)*

**Question.** Which byte range of `ROADMAP.md` belongs to milestone `M`?

**Owner.** `src/roadmap-parser.cts` — `locateMilestoneHeadings`, `computeMilestoneSectionEnd`, `isMilestoneBoundedInRoadmap`, and the composition `sliceMilestoneWindow`.

**Rule.** The window opens at the heading `locateMilestoneHeadings` selects for `M` and closes where `computeMilestoneSectionEnd` says. A `### Phase N: …` heading never opens or closes a milestone window. The version token's boundary is `\b`, **not** `(?![\w.-])` — a milestone STATE of `v8.0` legitimately selects `## v8.0-B …` over a closed `v8.0-A` sibling (#730; Amendment 2 tried the stricter boundary and reverted it). A free-form legacy ROADMAP carrying no versioned milestone heading is `COMPLETE`, not `UNSCOPED`: whole-document genuinely *is* the milestone there. **A composition of these primitives is itself an owner** — assembling `locate → pick → computeEnd → slice` at a call site is a re-derivation even though every step calls the owner (Amendment 2).

**Failure signal.** `ScopedResult.scope` per Decision 2.

**Guard.** `scripts/lint-milestone-window-drift.cjs`.

#### 7.2 Milestone identity — *Enforced (Phase 6, #3216)*

**Question.** Which milestone is current, and what is it called?

**Owner.** `src/roadmap-parser.cts` — `getMilestoneInfo`, returning `ScopedResult<MilestoneInfo | null>`, plus the version-agnostic `listMilestoneHeadings` added by Phase 6 for consumers that need *every* milestone heading rather than one. Both consume a single shared grammar source; `locateMilestoneHeadings` is a **version-filtered view** over that source, not a second expression of it. It is a **sixth derivation family** — the coverage audit's gap 2 — that no phase of the original decomposition touched.

**Rule.**
1. `STATE.md`'s `milestone:` field selects the version when present; the ROADMAP heuristics are the fallback, not the primary.
2. The heading is located by the canonical locator of §7.1, which already excludes phase headings. A `### Phase N: Close v3.3 gaps` heading is **never** the milestone heading (#3197 — reproduced live, writing a wrong `milestone:` to disk).
3. The **name** derives from the heading's **own** version token, not the requested one: remove everything up to and including that token, strip one leading delimiter (`—`, `–`, `:`, `-`), then strip any trailing run of the status markers `✅`/`📋`/`🚧`. `(` is an ordinary name character: the name is **not** truncated at a parenthetical (#3171). *(Requested `v2.0` against heading `## v2.0.1 — Portability` yields exactly `Portability`, not `.1 — Portability`; `## v2.0 — Old ✅` yields `Old`, because the shipped state is already carried structurally and must not be duplicated into the name.)*
4. A failure returns a `scope` other than `COMPLETE`. It does **not** return `{version: 'v1.0', name: 'milestone'}` presented as an answer — that default is output-identical to a successful read of a genuine `v1.0` project, which is this epic's defining failure mode.
5. **A free-form legacy ROADMAP carrying no version token anywhere is `UNSCOPED` with no identity** — *not* `COMPLETE`, and not a defaulted `v1.0`. §7.1's "free-form is `COMPLETE`" governs *windowing*, where whole-document genuinely is the window; identity has no version to report and must not invent one. **Decided 2026-08-08** (maintainer), closing the gap this section previously left unstated. **Corollary, stated because it is a distinct case and was initially left implicit:** a bare version token appearing only in prose or in a non-milestone heading — no `milestone:` field, no milestone heading — is weak but *real* evidence, and yields `TRUNCATED` with that version and a `null` name under rule 6, not `UNSCOPED`. `UNSCOPED` is reserved for a document carrying no version token at all.
6. A version known but no name resolvable is `TRUNCATED` carrying `{version, name: null}` — the version is a real answer, the name is a non-answer, and collapsing the two is the failure this contract exists to prevent.

**Guard.** `lint-milestone-window-drift.cjs`, token set widened by Phase 6 in the same change as the consolidation — never after, since a guard added later measures a surface already cleaned and reports a zero it did not earn. Token (a) now admits a **literal** `#`-run heading anchor in addition to the `#{N,M}` quantifier, but only inside a heading-**matcher** literal (a regex literal, or a string handed to `new RegExp(`), so a heading-**builder** template is not mistaken for a re-derivation. Token (b) additionally admits the grouped `v(\d+(?:\.\d+)+)` shape and an interpolated `${…Ver…}` placeholder.

#### 7.3 Phase enumeration — *Enforced (Phase 3, #3222 + #3185)*

**Question.** Which directories under `<planning>/phases/` are phases of milestone `M`?

**Owner.** `src/phase-locator.cts` · `listMilestonePhaseDirs` (Decision 1).

**Rule.** A directory counts **iff all three** hold: its identifier parses per `src/phase-id.cts`; it is not a sentinel per `isSentinelPhaseId`; and its ROADMAP entry falls inside `M`'s window per §7.1. Both filters, in that order. Any surface answering "how many phases does this milestone have" reports the same set for the same input — the progress renderer, the roadmap analysis, the statistics command and the phase listing are not allowed to disagree.

**Consumers that must route through the owner.** `cmdRoadmapAnalyze`, `cmdProgressRender`, `cmdStats`, `cmdPhasesList`, **and `buildStateFrontmatter` / `syncStateFrontmatter`** — the fifth copy, reached by `state.record-session`, `state.sync`, `phase.complete` and every other state-mutating verb, which the epic's original scope did not name (coverage-audit gap 1).

**Status, precisely.** Phase 3 (#3222) enforced this rule for `cmdRoadmapAnalyze`, `cmdProgressRender`, `cmdStats` and `cmdPhasesList`, and its guard (`scripts/lint-phase-enumeration-drift.cjs`) found 54 violations where the epic scoped 4. It also routed `buildStateFrontmatter`'s enumeration through `listMilestonePhaseDirs`, which Amendment 4's scope table row 1 did not credit it for — the audit read the *absence of the symbol names from Amendment 3* as the absence of the work. #3185's remainder was therefore smaller than recorded: the local dedup-key regex that survived alongside the routed enumeration, now on `phaseKeyFromDir`.

**What was actually unowned was one layer up.** `buildStateFrontmatter` decides whether it may *trust* the ROADMAP's declared count via `hasMilestoneSectioning` (§7.1), and that predicate — introduced by Phase 2 (#3184) to retire `state.cts`'s hand-rolled #2828 guard — was strictly more permissive than the guard it replaced, so a flat ROADMAP carrying an ordinary `## Progress` heading had its declared phase count discarded for the on-disk directory count (#3204). Fixed in #3185 by deciding milestone-ness from vocabulary rather than heading position; see §7.1 and the `CONTEXT.md` Roadmap Parser Module entry for the three position-based models that failed and why.

**The lesson this phase adds to Amendment 3's standing rule:** a copy count derived from *which symbol names appear in a prior amendment* is as unreliable as one derived from the reported issues. Read the code, not the write-up.

**Note on #3204.** Routing `buildStateFrontmatter` through the owner will not by itself fix #3204: its defect is the discriminator one layer *above* enumeration — "is the ROADMAP's phase count safe to trust" — which misclassifies ordinary `## Overview` / `## Progress` headings as milestone sectioning. That discriminator **is** §7.1's `isMilestoneBoundedInRoadmap`. The enumeration routing and the discriminator replacement must ship together or the defect survives the consolidation.

#### 7.4 Phase completion — *Required — Phase 4 (decided: disk-strict)*

**Question.** Is phase `P` complete?

**Owner.** `src/verification.cts` · `isPhaseComplete` (Decision 1).

**Rule.** `readVerificationStatus` is called **unconditionally**. Plan count is not a precondition: a phase with zero plans and a passing `*-VERIFICATION.md` is complete. The read path and the write path share this predicate, so "`phase.complete` succeeds while `init.manager` reports incomplete" is unrepresentable for identical input.

**DECIDED — disk state is authoritative; a ROADMAP checkbox does not override it (#2957, maintainer decision 2026-08-08).** This replaces the OPEN QUESTION this section previously carried, per §7's own rule that a behavior not stated here is not decided.

There are **three** completion implementations, not the two the epic recorded: `cmdPhaseComplete`, `buildPhaseCompletionProjection`, and `buildStateFrontmatter`, which computes completed phases from plan scanning alone and never consults the ROADMAP checkbox that `cmdRoadmapAnalyze` deliberately honors. The resolution:

1. **A ticked ROADMAP checkbox is a human annotation with no machine authority.** `cmdRoadmapAnalyze`'s deliberate honoring of it is the **divergent** behavior here, and it is **removed** rather than generalized.
2. `buildStateFrontmatter`'s existing plan-scanning semantics therefore become **canonical**, and all three implementations route through the one predicate.
3. The shared predicate derives completion from plan and verification state **on disk**, per the Rule above — `readVerificationStatus` unconditionally, plan count not a precondition.

**Why disk-strict.** A stale tick asserting completion over contradicting disk state is precisely the confidently-wrong answer this epic exists to remove, and it is the same failure shape as the `100`-percent aggregate (#3161): a well-formed, plausible value that no caller can distinguish from a real one.

**Tier-2 consequence (Decision 3).** A phase marked complete *solely* by a ticked checkbox — no passing `*-VERIFICATION.md`, plans outstanding — **stops reporting complete from `roadmap analyze`**. The break is deliberate and ships with its own breaking-change call-out, changeset fragment and docs update in Phase 4's PR.

**A missing verdict is not a passing one (decided 2026-08-10, maintainer).** `isPhaseComplete` is `verification.status === 'passed'`, so an **absent** `*-VERIFICATION.md` means **not complete** — everywhere, including `workstream list` / `status` / `progress`.

This retires #2645's deliberate boundary, which kept `missing` / `unknown` / `stale` out of the failing set specifically so a verifier-disabled project would not report 0% forever. Recorded rather than absorbed silently, because the consequence is real: **a project that never runs the verifier now reports its phases incomplete.**

It also closes #2645's Goodhart hole from the opposite side. That issue's symptom was that *deleting* a `*-VERIFICATION.md` **raised** the reported percentage — the metric could be improved by destroying the evidence. Under disk-strict, deleting it **lowers** completion, so the incentive inverts and the ledger's deletion-memory role is no longer load-bearing.

**Forcing function.** Phase 4's drift guard fails while more than one completion predicate exists. It cannot be satisfied by consolidating two of three and leaving the third.

**Consumers that must route through the owner.** `cmdPhaseComplete`, `buildPhaseCompletionProjection`, `buildStateFrontmatter` (the three #2957 names), plus `cmdRoadmapAnalyze`, `cmdInitManager`, `cmdRoadmapUpdatePlanProgress`, `buildWorkstreamInventory`, and the prompt layer's `mvp-phase.md` — **nine re-derivations found by the guard where this section named three.**

**A write-path gate is not a second predicate.** `cmdRoadmapUpdatePlanProgress` writes a completion checkbox, and completion alone does not mean every plan was executed — `readVerificationStatus`'s staleness check compares summary mtimes, never plan count. It therefore ANDs the owner's verdict with an explicit plan-coverage gate, mirroring the separate #2648 unexecuted-plan gate `cmdPhaseComplete` already carries. That composition is sanctioned; re-deriving completion beside it is not.

#### 7.5 Live-plan counting — *Enforced (Phase 1), with a known representation gap*

**Question.** How many plans in phase `P` are outstanding?

**Owner.** `src/plan-scan.cts` · `scanPhasePlans`, exposing `planFiles` (live) **and** `allPlanFiles` (every plan on disk, pre-supersession).

**Rule.** A plan is **live** unless it carries a machine-readable terminal state. The only terminal state today is frontmatter `status: superseded` (#2349). Choosing between the two sets is explicit per call site, never mechanical: **a diagnostic about file naming takes `allPlanFiles`; a question about outstanding work takes `planFiles`** (Amendment 1 — passing the filtered set into `describeNonCanonicalPlans` made a superseded-but-correctly-named plan report as a naming violation).

**GAP — the lifecycle has exactly one machine-readable terminal state (#1762, coverage-audit gap 6).** Plans retired through ROADMAP prose or HTML-comment fences carry no `status` key, so the canonical owner counts them live. Consolidation cannot fix this; it needs a representation that does not exist yet. The contract, locked now so no surface invents its own: **the plan lifecycle's terminal states are a closed, frontmatter-expressed vocabulary. Prose is not a lifecycle signal.** Until the vocabulary is extended, a plan a human considers retired but that carries no `status` key **is live**, and every surface reports it that way — a caller may not compensate by reading prose locally.

#### 7.6 Completion ratio — *arithmetic Enforced; rule 3 Enforced for `query progress` / `stats`; rule 4 Required — Phase 7*

**Question.** What percentage of a scoped set is complete?

**Owner.** `src/phase-lifecycle.cts` · `clampPercent(completed, total)` and `clampPercentFromFraction(fraction)`. A **seventh derivation family**, absent from the epic's table: the identical expression `total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0` was hand-inlined at six call sites across five modules while the owner sat exported beside them, unused by any of them.

**Rule.**
1. Exactly one expression of `fraction → integer percent` exists: round-half-up, ceiling 100.
2. A non-positive or absent denominator yields **0**. "Nothing to complete" is 0%, never 100%.
3. **The numerator and the denominator come from the same scoped set.** A percentage inherits the `scope` of the counts that produced it.
4. **A derivation whose scope is not `COMPLETE` does not render a percentage at all.**

**Status.**

- **Rules 1 and 2 — enforced.** Six sites migrated onto the owner, guarded by `scripts/lint-completion-ratio-drift.cjs`.
- **Rule 3 — enforced for `query progress` and `stats`.** Phase 3 (#3222) routed `cmdStats`'s and `cmdProgressRender`'s `totalPlans`/`totalSummaries` accumulation through `listMilestonePhaseDirs`'s scoped, sentinel-filtered set, so a backlog directory's already-summarized plans can no longer inflate the numerator against a milestone that has not finished. **That is what closed #3161**, and it is rule 3 by another name.
- **Rule 4 — Phase 7 (#3217).** Withholding a percentage entirely when the scope is not `COMPLETE` is not implemented anywhere. Phase 7 also re-checks any consumer Phase 3 did not reach, `cmdRoadmapAnalyze` first.

**Correction, recorded rather than quietly dropped.** Amendment 4 originally asserted that #3161 was *not* fixed by the arithmetic consolidation and that enumeration consolidation "changes nothing here" — and the second half was wrong. The two changes were authored concurrently; Phase 3 merged first and subsumed #3161 through the scoped set. The first half stands: the arithmetic consolidation alone would not have fixed it. Kept visible because a green ratio guard beside an unfixed #3161 would have been exactly the "measure became the target" outcome Decision 4 exists to prevent, and the reason it is not that outcome is Phase 3, not this change.

#### 7.7 State field extraction — *Required — Phase 5*

**Question.** What is the value of field `F` in a `.planning/` state document?

**Owner.** `src/state-document.cts` · `stateExtractField`, carrying the #1760 fallback chain.

**Rule.** Every consumer calls the owner; none re-derives the field's location or its fallback order locally. `state validate` reports invalid for a genuinely invalid document — an unconditional `{valid: true, warnings: [], drift: {}}` is a gate that cannot fail, which is worse than no gate (Decision 3).

**Call-site sweep is driven from the graph, not from the epic's text** — `find_symbol` reports 20 direct callers where #3180 says five.

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
- `scripts/qa-smell-ratchet.cjs` — the ratchet invariants Decision 4(e) adopts verbatim
- `scripts/lib/drift-scan.cjs` — the one tree-walk/confinement/sanitizer implementation every guard shares
- `CONTRIBUTING.md` § *Prohibited: Raw Text Matching on Test Outputs* — why `scope` is a frozen enum
- `CONTRIBUTING.md` § *Fixture provenance (#2371)* — why the identity test alone is insufficient
- Phase sub-issues: [#3183](https://github.com/open-gsd/gsd-core/issues/3183), [#3184](https://github.com/open-gsd/gsd-core/issues/3184), [#3185](https://github.com/open-gsd/gsd-core/issues/3185), [#3186](https://github.com/open-gsd/gsd-core/issues/3186), [#3187](https://github.com/open-gsd/gsd-core/issues/3187), and the three added by Amendment 4 — [#3216](https://github.com/open-gsd/gsd-core/issues/3216) (Phase 6, §7.2), [#3217](https://github.com/open-gsd/gsd-core/issues/3217) (Phase 7, §7.6), [#3218](https://github.com/open-gsd/gsd-core/issues/3218) (Phase 8, §7.5 + Decision 4(d)/(e)).

### Guard roster

One row per derivation. A blank owner is a derivation whose contract is locked (§7) but whose owner does not exist yet.

| Derivation | Owner | Guard | Scan surface | Status |
|---|---|---|---|---|
| Milestone windowing (§7.1) | `roadmap-parser.cts` | `lint-milestone-window-drift.cjs` | `src/` | enforced |
| Milestone identity (§7.2) | `roadmap-parser.cts` (Phase 6) | same guard, token set widened by Phase 6 | `src/` | enforced |
| Phase enumeration (§7.3) | `phase-locator.cts` | `lint-phase-enumeration-drift.cjs` | `src/` | enforced — the state writers included (#3185) |
| Phase completion (§7.4) | `verification.cts` (Phase 4) | Phase 4 | `src/` | contract decided (disk-strict, #2957); migration is Phase 4 |
| Live-plan counting (§7.5) | `plan-scan.cts` | `lint-plan-count-drift.cjs` | `src/` | enforced |
| Live-plan counting, prompt layer (§7.5) | — (Phase 8) | `lint-planning-prompt-drift.cjs` | `gsd-core/workflows`, `commands`, `agents`, `skills` | ratcheted, 7 sites |
| Completion ratio (§7.6) | `phase-lifecycle.cts` | `lint-completion-ratio-drift.cjs` | `src/` | arithmetic + rule 3 enforced; rule 4 is Phase 7 |
| State field extraction (§7.7) | `state-document.cts` (Phase 5) | Phase 5 | `src/` | contract only |

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

### Amendment 3 — Phase 3 (#3185) validation: the contract held; the load-bearing bug was upstream of enumeration itself

Decision 2's contract **held** for its third consumer: `listMilestonePhaseDirs` returns
`ScopedResult<string[]>` unchanged, and `SCOPE` needed no new member — every case Phase 3 hit
(a genuinely empty milestone, a truncated window, an unscoped/legacy ROADMAP, an unreadable
ROADMAP) was already one of the four frozen values.

**Declared deviation from Decision 1's provisional signature.** Decision 1 locked
`listMilestonePhaseDirs(roadmapContent: string, phasesDir: string, deps?): ScopedResult<string[]>`.
That signature cannot work: the milestone window needs `cwd` (to read `STATE.md` for the active
milestone version) and `ws` (workstream scoping), and `getMilestonePhaseFilter` — the post-#3184
canonical owner of "read the ROADMAP and resolve the window" — reads `ROADMAP.md` itself rather
than accepting its content as an argument. Threading a pre-read `roadmapContent` string past that
owner would reintroduce a second ROADMAP-reading path beside it, which is exactly the divergence
class this epic removes. Shipped signature:
`listMilestonePhaseDirs(phasesDir, { cwd, ws, versionOverride, phaseIdConvention })`. This is a
signature change, not a contract change — `ScopedResult<T>` and `SCOPE` are unaffected, so it does
not require re-litigating Decision 2.

**The copy count was a lower bound, a third consecutive time.** The epic scoped enumeration at
**4 copies**. The Decision 4(a) whole-repo guard (`scripts/lint-phase-enumeration-drift.cjs`) found
**54 violations**: 23 sentinel re-derivations across 8 modules, in three regex variants plus four
integer-comparison forms, now consolidated onto the canonical `isSentinelPhaseId`
(`SENTINEL_RANGES [0, 999]`); plus 31 unscoped `phasesDir` reads. Most of the 23 sentinel
re-derivations tested only `999`, so Phase 0 previously slipped through every one of them.

**The load-bearing finding: the sentinel exclusion lived on the wrong set.** The pre-existing
sentinel exclusion was applied to the ROADMAP HEADING set (`### Phase N:` entries), not to
phase-directory names — but `getMilestonePhaseFilter` degrades to a literal pass-all `() => true`
when that heading set is empty, per Decision 3's documented "over-inclusive, never
under-inclusive" promise. The exclusion was therefore unreachable exactly when it was needed: a
backlog or pre-milestone directory has no corresponding ROADMAP heading to exclude by, so the
filter that was supposed to keep it out degraded to accepting everything instead. This is the same
path #3167 named, and it is why `cmdStats` already called `getMilestonePhaseFilter` and still
listed backlog directories — calling the filter was not enough while the filter's own pass-all
degrade could not distinguish "no phases in this milestone" from "no heading to test this directory
against." The fix applies the sentinel test to **directory names**, unconditionally, after the
window filter runs rather than folding it into the window filter's heading-matching logic. The
narrowing is sentinel-only: pass-all still stands for every non-sentinel directory the window
filter cannot place, so Decision 3's promise is narrowed minimally, not revoked (Decision 3 /
Hyrum's Law).

**#3161 is subsumed alongside #3167, as the Tier-2 table predicted.** #3161 ("aggregate percent
reports 100 while plans are outstanding") shared the same upstream cause: `cmdStats`'s and
`cmdProgressRender`'s `totalPlans`/`totalSummaries` accumulation now iterates the single owner's
scoped, sentinel-filtered `dirs` set (`listMilestonePhaseDirs`'s `value`) instead of an unscoped
`readdirSync` of the phases directory, so a `999.*`/`0-*` directory with its own already-summarized
plans can no longer inflate `totalSummaries` (or `totalPlans`) against a milestone that has not
actually finished — the same backlog-dir listing bug row 3 named, manifesting in the percent
aggregate rather than the phase list.

**Two destructive-path defects the sweep exposed.** `phases clear` carried the fifth sentinel copy
and its third regex variant (`/^999(?:\.|$)/`) — it excluded `999` but not `0`, so a `0-*`
pre-milestone directory was deleted (or, pre-#1871, hard-removed) on this irreversible path.
`milestone complete`'s phase-archival move had no sentinel filter at all on its stats/dry-run/move
paths — only the milestone window — so a sentinel directory sitting inside the window's phase range
could be archived alongside the milestone's own phases. Both now route through
`isSentinelPhaseId` directly (not through `listMilestonePhaseDirs`, since both need every
non-sentinel directory regardless of milestone window — see the generalized rule below).

**An unadvertised but correct Tier-2 change.** Phase 0 directories now drop out of
`progress`/`stats`/`phases list` alongside Phase 999, because the canonical predicate treats both
sentinels alike and the engine-wide convention (#1580) already declares both as sentinel ranges,
while `roadmap analyze` (Phase 2) already honored it. This was not separately predicted by Decision
3's table — it falls out of routing every reader through one predicate that was already correct.

**The guard's own false positive, worth recording.** The first version of
`scripts/lint-phase-enumeration-drift.cjs` flagged JSDoc comments and inline comments that merely
*documented* that the code below already called the canonical owner — matching sentinel-shaped
regex literals inside prose, not code. It is now comment-aware (skips block/line comments before
matching). Recorded because a guard that reports prose as drift trains its readers to reflexively
exempt documentation, which is the opposite of Decision 4(a)'s whole-repo, no-allowlist intent.

**The generalized exemption rule**, restated from Amendment 1's file-naming case in this
derivation's terms: a **lookup**, **diagnostic**, **archival**, or **mutation** pass wants the
physical directory set — every non-sentinel directory on disk, regardless of milestone window.
Only "which phases belong to the current milestone" wants the scoped set `listMilestonePhaseDirs`
returns. `phases list --phase N` and `--include-archived` (lookup/archive) and `phases clear` /
`milestone complete` (destructive mutation) take the first; `progress`, `stats`, and the bare
`phases list` take the second.

**Decision 3's Tier-2 table, re-derived for Phase 3** per its own contingency clause:

| Command surface | Output change |
|---|---|
| `query progress`, `stats`, bare `phases list` | `999.*` backlog and `0-*` pre-milestone directories are no longer listed or counted as current-milestone phases; the aggregate completion percentage stops reading `100` while phases in the active window are still outstanding |
| `phases clear` | no longer deletes/archives a `0-*` pre-milestone directory — previously excluded `999` but not `0` on this irreversible path |
| `milestone complete` | its phase-archival move no longer sweeps sentinel directories into `.planning/milestones/<version>-phases/` alongside the milestone's own phases |
| `stats` P0.0 plan-count correction — **not predicted** | `isDirInMilestone` could not match a #1324 letter-prefixed-decimal directory (`P0.0-foundation`) to its own `### Phase P0.0:` ROADMAP heading, so `stats` reported that phase with `plans: 0` while its directory held real plan files. Fixed inline as part of the same sweep; not a Decision-1 owner change, but a defect the whole-repo guard's investigation surfaced in the same code path |

**A single owner is not always a single RULE — the `0.x` split.** The sharpest finding of this
phase, and a correction to how Decision 1 reads. An isolated security review observed that
`isSentinelPhaseId` classifies `0.1` / `00.1` as sentinel milestone 0 (its `/^0*(\d+)/` backtracks
to capture `0`), and that this looked wrong against #2554. Changing the canonical predicate to
exempt `0.x` made the suite fail **six** tests, because two PINNED contracts disagree — and both
are right, because they ask different questions:

| Contract | Question | Verdict on `0.x` |
|---|---|---|
| #2554 (`roadmap-parser.test.cjs`) | is this directory part of the current milestone's phase SET? | **count it** — a `00.1-<slug>` dir declared as `### Phase 00.1:` is a real phase |
| #2949 (`phase.test.cjs`, folded:issue-2949-phase-complete-stage3-sentinel) | must this phase COMPLETE before the milestone can close? | **sentinel** — a `0.x` must not block `is_last_phase` |

No single global predicate answers both. The resolution is layered, not unified: `isSentinelPhaseId`
keeps its semantics (`0.x` IS a sentinel, satisfying #2949), and the milestone-WINDOW layer keeps a
narrower 999-only rule (satisfying #2554), carried as a function-scoped guard exemption with a
written reason rather than a second silent copy.

**The lesson for Phases 4 and 5:** "one owner per derivation" governs *who computes an answer*, not
*how many questions share it*. Before folding a call site onto a canonical predicate, establish
which question that site asks — an over-broad canonical rule is as much a defect as a divergent
copy, and it fails in a worse way, because it looks like consolidation. Note also that the
security review's data-completeness concern here was *inference* about intent, while #2949 is
*pinned* intent; where the two conflict, the pinned contract wins and the review finding is
recorded as adjudicated rather than fixed.

**Scope note.** Phase 3 is the last consumer of the enumeration/window layer; Phases 4 and 5 build
on the completion and state-extraction derivations respectively and do not depend on
`listMilestonePhaseDirs`.

### Amendment 4 — the 2026-08-08 coverage audit: two more derivation families, a fifth enumeration copy, and a guard that was looking at half the surface

> **Written before Phase 3 merged, reconciled against it after.** This amendment and Amendment 3
> were authored concurrently and reached the same conclusion independently — the copy count is
> always a lower bound and only the whole-surface guard makes it real (Amendment 3 found 54
> violations where the epic scoped 4). Amendment 3 states that rule; this one does not restate it.
> Three of this amendment's original claims were superseded by what Phase 3 actually shipped, and
> each is corrected in place below rather than left standing.

Source: the coverage audit posted to #3180 on 2026-08-08, which tested every open non-PR'd `bug`
on the tracker against one question — *would executing this epic's stated work, by itself, make the
reported symptom stop?* Four issues passed and were closed into the epic (#3164 and #3166 as already
discharged by Phases 1 and 2; #3167 and #3168 as covered by open Phases 3 and 4). Seven did not.
This amendment is what the seven change.

**What the audit added to the copy count.** A fifth enumeration copy, a third completion predicate,
and **two derivation families the epic never named at all**. Amendment 3 states the standing rule
this is the fourth instance of, and states it from a stronger position — 54 violations against a
scoped 4 — so it is not restated here.

**Scope changes.**

| # | Change | Why the existing phases do not cover it |
|---|---|---|
| 1 | ~~**Phase 3 widens** to include `buildStateFrontmatter` and `syncStateFrontmatter`~~ — **twice superseded; closed by #3185.** First reading ("Phase 3 merged without them") was itself wrong: #3222 *had* routed the enumeration, and the audit mistook Amendment 3's silence for absent work. The real gap was the trust discriminator one layer above — see §7.3 | Routing alone would never have fixed #3204: a correctly scoped enumeration still returns the directory count. The defect was `hasMilestoneSectioning`, introduced by Phase 2 (#3184) and more permissive than the #2828 guard it retired |
| 2 | **Phase 4 blocks on #2957** and its guard must fail while a third predicate exists | The audit found `buildStateFrontmatter` computing completed phases from plan scanning alone, ignoring the ROADMAP checkbox `cmdRoadmapAnalyze` honors. Checkbox-override vs disk-strict is an undecided product question, not a consolidation |
| 3 | **Phase 6 — milestone identity** (§7.2): bind `getMilestoneInfo` to `locateMilestoneHeadings`, widen the windowing guard's token set in the same change (#3171, #3197) | A sixth derivation family. Phase 2 consolidated *windowing*; `getMilestoneInfo` hand-rolls its own heading regexes to answer a different question — *which milestone is this and what is it called* — and no named phase touches it |
| 4 | **Phase 7 — completion-ratio scoping** (§7.6 rules 3–4). **Corrected: #3161 is NOT fixed here — Amendment 3 subsumed it.** Phase 7 keeps rule 4 and whatever consumers Phase 3 did not reach | A seventh derivation family. This amendment ships the arithmetic half. Its original claim — that enumeration consolidation "changes nothing here" — was **wrong**, and Phase 3 proved it: routing `cmdStats`/`cmdProgressRender`'s `totalPlans`/`totalSummaries` accumulation through `listMilestonePhaseDirs`'s scoped set *is* §7.6 rule 3 for those two consumers, and it is what closed #3161 |
| 5 | **Phase 8 — the prompt layer**: give the workflow layer a CLI surface to ask for plan and phase counts, and burn the ratchet baseline to zero | The re-derivation lives in shell inside `gsd-core/workflows/*.md`. No `.cts`-scoped guard can see it, and no import can route it — it needs a command to call |
| 6 | **Plan-lifecycle terminal states** (§7.5) are declared a closed frontmatter vocabulary, with the gap recorded rather than papered over | Consolidation cannot fix #1762's prose-retired plans; the canonical owner counts them live and is *correct* to, under the contract as written |

**Ordering.** Phase 6 is independent of Phases 3–5 and may ship at any point. Phase 7 follows Phase 3
(its scoping is what makes rules 3–4 expressible). Phase 8 follows whichever phase first exposes the
CLI surface it calls. Decision 5's locked 1→2→3→4→5 order is unchanged.

**What shipped in this amendment's own change.**

- Decision 4(d) — scan surface is every authored surface, and an owner **file** is no longer exempt, only its named canonical **functions**. `lint-milestone-window-drift.cjs` exempted `src/roadmap-parser.cts` wholesale, which is constraint (a)'s forbidden allowlist pointed at the file most likely to grow the next copy — and it had: `getMilestoneInfo` sits inside it, invisible.
- Decision 4(e) — the ratchet mechanism, so a surface that cannot be consolidated today is watched today.
- Decision 7 — the behavior contract, this ADR's normative core.
- **Completion ratio consolidated**: `clampPercentFromFraction` added beside `clampPercent`; six inline copies across `roadmap.cts`, `state.cts`, `commands.cts` (×2), `workstream-inventory-builder.cts`, `gsd2-import.cts` and `state-document.cts` migrated onto the owner; `scripts/lint-completion-ratio-drift.cjs` added, reporting zero re-derivations with no file-level exemption.
- **Prompt layer made visible**: `scripts/lint-planning-prompt-drift.cjs` added with a shrink-only baseline covering the 7 sites across `progress.md`, `execute-plan.md`, `plan-phase.md` and `plan-review-convergence.md`. **Phase 8 (#3218) owns their removal, and every baseline entry names it** — Decision 4(e) requires the acknowledgment to point at the issue that removes it, not at the epic.

**Decision 3's Tier-2 table, re-derived for this amendment: no rows.** Every percent migration is
behavior-identical — `clampPercent`'s first line *is* the `total > 0 ? … : 0` ternary each copy
carried. The single deliberate difference is `gsd2-import`'s `pct`, which gains a 100 ceiling it did
not have; `donePhases` is a subset count of `totalPhases`, so the ceiling is unreachable and no
emitted value changes.

**Explicitly NOT absorbed, and left open on their own issues.** #3165's *answer* remains unrepaired —
Phase 2 made the truncated window decidable (`SCOPE.TRUNCATED`) but `phase_count` is still `0` and
`current_phase`/`next_phase` still `null`, so its first acceptance criterion is unmet and the
underlying document-layout ambiguity is untouched by design. #3163 belongs to #2143's sectionizer
layer and is not enumerated there yet; #3169 and #3170 are standalone parser/extraction defects with
no epic home. Recording them here as *not covered* rather than leaving them to be re-tested by the
next audit.

### Amendment 4 — Phase 6 (#3216) validation: the contract held; the blessed implementation carried the defect again

**The copy count was a lower bound for the FOURTH consecutive time.** The epic and §7.2 both scoped
this phase at one copy — `getMilestoneInfo`. The guard, built and run *before* the scope was fixed
per Amendment 3's standing rule, found **three**:

| # | Site | Carries |
|---|---|---|
| 1 | `roadmap-parser.cts:785` — `^##[^\n]*${escapedVer}…` | #3171 + #3197 |
| 2 | `roadmap-parser.cts:806` — `/## (?!.*✅).*v(\d+(?:\.\d+)+)…/` | #3171 + #3197 |
| 3 | **`roadmap.cts:454`** — `cmdRoadmapAnalyze`'s own milestone enumeration | #3171 + #3197 |

Site 3 is the notable one, and it repeats §7.6's finding exactly: **the implementation this epic
blessed carried the defect it was blessed over.** `cmdRoadmapAnalyze` is named in Decision 1 as the
correct enumeration implementation, and its `milestones[]` array was simultaneously truncating names
at a parenthetical and emitting `### Phase N` headings as milestones. Twice now the blessing has
been granted per-question rather than per-file, and twice the blessed file has held an unrelated
copy. **Blessing an implementation for one derivation says nothing about its others.**

**Two mechanisms, not one.** Site 1 is line-anchored but level-blind (`^##` then `[^\n]*` absorbs a
third `#`); site 2 and site 3 have no anchor at all, so `## ` matches from the *second* `#` of
`###`. A reviewer checking "is it anchored?" would have passed site 1. This is why §7.2 rule 2 names
the canonical locator rather than describing the anchoring to be re-implemented.

**Two under-specifications surfaced during implementation, both now closed in §7.2 rule 3.** Neither
was reachable by reading the contract alone; both appeared only when tests demanded an exact value.
(a) *Which* version token the name is measured from, when the requested version is a prefix of the
heading's own — `v2.0` against `## v2.0.1 — Portability` left `.1 — Portability` under the original
wording. (b) A trailing `✅` was being retained *in the name*, duplicating structural state into a
string that `buildStateFrontmatter` writes to disk. Both are now stated normatively rather than
settled inside the implementation.

**§7.2's unstated case is now decided (rule 5).** Free-form legacy ROADMAP with no version anywhere
→ `UNSCOPED`, no identity. §7's own rule — *"a behavior not stated here is not decided"* — held: the
gap was raised and decided by the maintainer before implementation rather than resolved silently.

**A latent defect was found in a caller, not by the guard.** `init.cts` carried
`getMilestoneInfo(cwd) as unknown as Record<string, unknown>`. The cast masked the return-type change
across five call sites, so `tsc` stayed green while every one of them would have read `undefined`,
and one template would have rendered the literal string `"undefined"`. A structural drift guard
cannot see this class — an unsafe cast is not a re-derivation — which is the concrete argument for
Decision 4(b)'s pairing: the type checker was the output metric and it was green; migrating and
running the consumers was the outcome metric.

**Tier-2 output changes (Decision 3).** `state sync` / `state record-session` persist a corrected
`milestone:` and name, or `null` rather than a fabricated identity; `roadmap analyze`'s `milestones[]`
no longer truncates names and no longer lists phase headings; `phases clear` falls back to its dated
archive label rather than misfiling under a fabricated version; `query progress`, `stats`,
`init manager`, `validate health` and `workstream create` render the full name.

Five further Tier-2 surfaces were missed in this amendment's first draft and are recorded here after
the Phase 6 spec review caught the omission — Decision 3 requires *every* Tier-2 change be called
out, and an incomplete list is the same defect in miniature that this epic exists to remove:

- **`commit`** (`cmdCommit`) — when `branching_strategy` is `milestone`, the constructed branch name
  now derives from a scope-checked identity. A `COMPLETE` identity produces the same branch name as
  before; a `TRUNCATED` one (real version, unresolved name) still produces a branch, deliberately,
  because the version is real — the acceptance is now explicit in code rather than incidental to a
  truthiness check. Contrast `archivePhaseDirectories`, which demands `COMPLETE` because it uses the
  value as a filesystem path component.
- **The four `init` JSON bundles** — `init execute-phase`, `init new-milestone`, `init milestone-op`
  and `init progress` — emit `milestone_version` / `milestone_name` / `current_milestone` as an
  explicit `null` when identity is unavailable, where they previously carried the fabricated
  `v1.0` / `milestone`. The keys are always PRESENT so the prompt layer cannot render a bare
  placeholder; `JSON.stringify` had been dropping them when the value went `undefined`.

**Guard.** The owner file stays scanned; `listMilestoneHeadings` joins `FUNCTION_SCOPED_EXEMPTIONS`
as a *named canonical function* — the only sanctioned exemption form. `locateMilestoneHeadings` was
refactored into a version-filtered view over one shared grammar source so the two primitives cannot
drift, with a parity test asserting the filtered enumeration equals the locator's selection.

### Amendment 5 — Phase 5 (#3187) validation: the contract held; the guard nearly reported a zero it had not earned

Decision 2's contract needed **no change** for its fifth consumer. `stateFieldValue` returns
`{ value, scope }` over the frozen four-member `SCOPE`, and every case this phase hit was already
one of them. `src/planning-scope.cts` is untouched, so Phase 5 carries no `.cts` six-gate ripple.

**Declared deviation from Decision 1's owner surface.** Decision 1 names the owner as
`stateExtractField` "carrying the #1760 fallback chain". Shipped instead: `stateExtractField` is
left **byte-identical** and the chain is a *new* owner beside it. `stateExtractField` answers a
narrower question — "what is field F in this body text" — which genuinely has no scope dimension,
and it has **20 direct callers with a CRITICAL blast radius** (53 affected symbols, 5 process
flows). Putting the scope on the primitive would have rewritten every one of those call sites to
buy nothing. The thing that can fail to run is the *chain*, so the chain is what carries the scope.
This is a signature deviation, not a contract change — the same class Amendment 3 declared for
`listMilestonePhaseDirs`.

**The copy count was a lower bound for the SIXTH consecutive time — 14, where the epic scoped 5.**
Per Amendment 3's standing rule the guard was built and run **before** scope was fixed. Grouped by
ladder-bearing function: `cmdStateSnapshot` 11, `cmdStatePrune` 2, `smart-entry.cts::fmScalar` 1.
`find_symbol` separately reports 20 direct callers, which is the figure §7.7 already told Phase 5 to
drive from rather than the epic's "five call sites".

**The first guard would have lied, and the mechanism is worth recording because it is new.** A
bounded-line-window detector was built first and found **7**. The other **7** —
`state.cts:1484–1497` — sat further from `cmdStateSnapshot`'s ladder than its 15-line window
reached. Migrating the visible 7 would have left a green guard with seven survivors: Decision 4(a)'s
"a zero it did not earn", arrived at by a mechanism no prior phase met. Replaced with
**function-scoped co-occurrence** — *a function that both reads a frontmatter scalar and calls the
body extractor is re-deriving the chain* — which needs no threshold constant and cannot be reflowed
around. **Generalized lesson: any numeric window in a drift guard is a Goodhart target; scope
detection to a syntactic unit instead.** Two further evasions (a member/computed operand, a swapped
tier order) were found by the isolated review and closed with their own tests; a guard is not
trusted until a deliberate re-derivation is shown to fail it.

**Decision 4(d) applied to this derivation, and it bit again.** The guard's first scan surface was
`src/` — which is exactly the one-directory-wide allowlist 4(d) was written to forbid, repeated by a
phase that had read 4(d). `gsd-core/workflows/smart-entry.md` instructs an agent to read `status`
from "frontmatter `status:` or body `**Status:**`" — a prose expression of this chain. The surface
is now scanned. That site carries a **permanent exemption with a written reason**, not a Decision
4(e) ratchet: it is the `gsd-tools`-is-down fallback, so by construction it cannot call the owner,
and a ratchet implies removable debt with an owning issue. **Not every unconsolidated site is
debt** — 4(e) governs debt, and a documented impossibility is a different thing.

**A seventh derivation family was found and deliberately NOT consolidated, on evidence.** Three
`## Current Position` locators exist. `state.cts::matchCurrentPositionSection` genuinely delegates
to `state-document.cts::stateCurrentPositionSlice`, so it is not a copy. But
`state-transition.cts::locateCurrentPosition` / `sliceCurrentPositionSection` is independent, and
both were run over eight adversarial bodies. Fence-awareness turned out to be **shared** (both reach
`tokenizeHeadings`), so that concern was unfounded — but the two diverge in *both* directions:
`locateCurrentPosition` misses `### Current Position` at h3, while `collectSection` applies
`.trimEnd()` where the byte-exact mutation callers (`mutateCurrentPositionFirstTime` /
`mutateCurrentPositionResume`) depend on the trailing newline for span reassembly. Folding would
silently drop a newline from every Current Position body on every write. **This is Amendment 3's
"0.x split" recurring: one owner governs who computes an answer, not how many questions share it.**
Left for its own phase; `CONTEXT.md`'s claim that the read-path slice is "the one owner of that
scope" is corrected to name the mutation-path locator.

**Decision 3's Tier-2 table, re-derived for Phase 5:**

| Command surface | Output change |
|---|---|
| `state validate` | gains `scope`. `valid` is **not** routed from it — Decision 2 rejected a boolean ok/degraded, and a legacy STATE.md with no `## Current Position` is `UNSCOPED`, a supported degrade, not an invalid document. It also stops resolving its phase from unstripped content, closing a #1255-class frontmatter shadowing where a frontmatter `status:` key won over the body field |
| `state complete-phase` — **not predicted** | the #3489 idempotency guard now consults frontmatter `current_phase`, so a project whose phase lives only in frontmatter is no longer silently rolled back on a re-run; adds a refusal when frontmatter cannot be read |
| `workstream` inventory — **not predicted** | `readStateProjection` resolves frontmatter-only `status`/`current_phase`/`last_activity` instead of reporting them absent |
| `state snapshot`, `state prune`, `/gsd:next` signals | resolve fields through the one owner, so they can no longer disagree about the same STATE.md. `smart-entry`'s read stays deliberately **unscoped** under a written exemption — it asks a different question than `state.cts`'s #1776/#2956-scoped copies, and folding it would silently change routing |

**What this phase does NOT close.** §7.7's rule says `state validate` "reports invalid for a
genuinely invalid document" but never defines *genuinely invalid*. This phase does not invent that
definition — it makes the derivation's scope visible so the question becomes answerable, and emits
the drift warnings that were always intended but unreachable. Widening what counts as invalid stays
undecided, per §7's own rule.
### Amendment 6 — 2026-08-09: the diagnostic layer, and a citation convention for the duplicated Amendment 4

**Phase 9 (#3287). Docs-only; adds Decision 8. Nothing in the tree changes on this merge.**

This section is **append-only by construction**: `docs/adr/README.md` states "ADRs are append-only.
Amendments extend existing ADRs with a dated section rather than replacing them", and
`docs/contributor-standards.md` adds "the original body is never rewritten." An earlier draft of this
amendment edited §6, the Guard roster, the status block and a historical heading in place. That was a
standards violation caught in review and reverted; every change below is *declared here* and the
original body is untouched.

**Line numbers in this section are as of `next` @ `2dbee3ebd`** and will drift; the symbol names are
the durable anchors. Where a number below corrects an earlier draft, the correction is noted — a
design lock citing the wrong line teaches the next reader the wrong thing.

**Phase 5 (#3187) merged while this amendment was in review, and it changed one of the facts below.**
Re-verified against `2dbee3ebd` rather than restated from the draft: `cmdStateValidate` no longer
reads a bare literal — it now calls `stateFieldValue(fm, body, 'current_phase', 'Current Phase')`
(`state.cts:2943`), consults frontmatter first, and early-returns on `currentPhase === null`
(`state.cts:2949`). So **#3162 is fixed on `next`**, exactly as §6's subsumption table predicted it
would be. That removes one of the two instances this amendment originally cited and is recorded here
rather than silently dropped, because the prediction coming true is evidence for Decision 8, not
against it. `verify.cts` was untouched by Phase 5, so the checker-side instance below still stands.

#### 6a. Citation convention for the two sections numbered "Amendment 4"

**On this amendment's own number.** Seven amendment sections now exist but only six distinct numbers
are used — 1, 2, 3, 4 twice, and 5 (taken by Phase 5, #3187, which merged while this amendment was in
review). This section takes **6**, the next unused number, so the sequence reads 1, 2, 3, 4a, 4b, 5, 6
with no phantom gap.

Two sections carry the heading `### Amendment 4`. Renaming either would rewrite the original body, so
they are **not renamed**; instead they are disambiguated by origin, and later text should cite them
this way:

| Cite as | Heading | Introduced by | Subject |
|---|---|---|---|
| **Amendment 4a** | "the 2026-08-08 coverage audit…" | PR #3223 (`b9f51836e`) | two more derivation families, a fifth enumeration copy, a half-surface guard |
| **Amendment 4b** | "Phase 6 (#3216) validation…" | PR #3226 (`86bebcefa`) | milestone identity; three copies found where one was scoped |

Every pre-existing in-body citation of "Amendment 4" was audited against both candidates and refers
to **4a** — the status block's "adds Decision 7", Decision 4's "see Amendment 4", §7.3's "Amendment 4's
scope table row 1", §7.6's "Amendment 4 originally asserted", and the Cross-references' "the three
added by Amendment 4". None is ambiguous in effect, so none is edited.

#### 6b. Scope, as extended by this amendment

§6's lists are not rewritten. As of this amendment they are read with these additions:

- **In scope, added:** the *diagnostic layer* — the surfaces that report on these derivations
  (Decision 8 below) and its two guards.
- **Out of scope, added:** `state.sync`. It is a *writer* whose disk scan belongs to §7.3's owner, so
  Decision 8 refers rather than duplicates — the posture `CONTEXT.md` § *Bespoke vs Canon Prohibition*
  already names, "referred, not duplicated". Also out: the repo-wide "every validator proves it can
  fail" gate, which belongs to epic #3053; Decision 8.5 requires the fixture only for the rules it
  defines.
- **§6's Phase 5 scope note is resolved.** It reads "#3180's Done-when list should be amended to
  match, or Phase 5 reads as unclaimed scope." Verified against the live epic: the list already
  carries a *State field extraction* item bound to Phase 5, so the note is historical. Re-checking it
  surfaced a live instance of the same defect — this amendment's own — because §6 now admits a layer
  the epic's Done-when list did not claim. A *Diagnostic layer* item was added to #3180 in the same
  change; shipping the warning while reproducing the fault would have been the worse outcome.

#### 6c. Guard roster, as extended by this amendment

Two rows join the roster (declared here rather than inserted above):

| Derivation | Owner | Guard | Scan surface | Status |
|---|---|---|---|---|
| Diagnostic subject (8.1) | `planning-snapshot.cts` (Phase 10) | `lint-planning-snapshot-bypass-drift.cjs` | `src/` | enforced |
| Planning-artifact registration (8.4) | `artifacts.cts` | `lint-planning-artifact-writer-drift.cjs` (Phase 12) | `src/` | contract only |

**The second row is a different shape, recorded as such rather than filed under a contract it does
not match.** Every other row guards a derivation's **uniqueness** — that exactly one implementation of
an answer exists. The artifact-registry guard proves a registry's **completeness**: that every writer
producing a `.planning/` root file is represented in `artifacts.cts`. It scans for *writers*, not
re-derivations, so "0 independent re-derivations" is not its success condition — "0 unregistered
writers" is. It belongs in this roster because it is the same mechanism (whole-surface scan,
ratcheted, shrink-only) applied to an adjacent failure mode.

#### Why the diagnostic layer is the same failure class, one layer up

Decisions 1–7 gave every derivation an owner and a written correct answer. They said nothing about the
surfaces that **report** those answers, and the defect history moved there.

`cmdValidateHealth` (`src/verify.cts:1553-2459`) is a single 907-line function, `complexity_score` 28,
one direct caller, emitting 30+ codes through one nested
`addIssue(severity, code, message, fix, repairable)` closure (`verify.cts:1599`) where severity is a
per-call argument rather than a property of the code. Each check re-derives the thing it checks, and in
every row a correct implementation already exists beside the broken one:

| What the checker re-derives | Its version | The owner beside it | Issue |
|---|---|---|---|
| The current phase | W011 reads `/\*\*Current Phase:\*\*/i` then `/Current Phase:/i` (`verify.cts:1992-1993`, emit `:2006`) and matches neither against real output | §7.7's owner, now `stateFieldValue` — which `cmdStateValidate` was migrated onto by Phase 5 (`state.cts:2943`), fixing #3162. `buildStateFrontmatter` (`state.cts:1631`) still carries the older `stateExtractField(bodyContent, 'Current Phase') ?? prosePhase.phase` form | #3280 (#3162 closed by Phase 5) |
| Real vs sentinel phase dir | health's `collectDiskPhases` (`verify.cts:1346-1366`) applies no filter | `isSentinelPhaseId` (`phase-id.cts:378-394`) — **1 caller, and health is not it** | #3225 |
| Recognized `.planning/` artifact | `isCanonicalPlanningFile` (`artifacts.cts:42`) — **1 caller, 0 callees**, 11 hand-typed names | no writer registers; `.planning/WINDOWS.md`, which gsd-core itself writes, is absent | #3224 |
| Disk-vs-roadmap phase comparison | a **second** copy in `cmdValidateConsistency` (`verify.cts:1413-1551`), emitting bare strings with no code | §7.3's enumeration owner | #3225, second copy |

**A gate that cannot fail — one instance left, and the arithmetic is shown.** The shipped template
(`gsd-core/templates/state.md:32`) emits `Phase:` under `## Current Position`; the literal
`Current Phase` appears nowhere in it. The class had two members when this amendment was drafted:
`cmdStateValidate`, which §7.7 already governed, and **W011** (`verify.cts:1992-1993`, emit `:2006`),
which no decision covered. Phase 5 fixed the first by migrating it onto §7.7's owner. W011 remains,
because `verify.cts` sits in a surface Decisions 1–7 do not reach — which is the whole argument for
Decision 8, stated by a live example rather than by assertion. **A derivation getting an owner does
not fix the surfaces that report on it; only owning those surfaces does.**

**An earlier draft of this amendment claimed three instances and named W002 as the third. That was
wrong and is corrected rather than quietly dropped.** `verify.cts:1646` is a generic
`[Pp]hase\s+(TOKEN)` reference collector and W002 emits at `:1682`; it cross-checks any phase
reference against the disk set and has nothing to do with the `Current Phase` literal. Recording the
error because a design lock's central evidence claim is exactly the thing a later reader will not
re-verify — and because the same over-count is what Amendment 4a's standing rule warns about, in the
other direction.

**The correct model was in the prompt layer the whole time.** `gsd-core/workflows/health.md:169-190`
publishes a roster declaring severity and repairability **per code**, plus a repair-actions table with
named actions and a **risk** column. The code carries only `fix: string` and `repairable: boolean`. The
published roster carries **17 rows** against the 30+ codes emitted, so W010–W017 and W020–W023 have
never been documented — the doc is not merely stale, it is structurally unable to keep up, because
nothing derives it. Decision 8 inverts that: the rule table becomes the source and the table is
generated from it. *(An earlier draft said 16 rows; the table is E001–E005, W001–W009, W018, W019 and
I001 — 17.)*

**Codes are not 1:1 with subjects.** W021 (`:2172` milestone-prefixed phase mismatch, `:2276`
milestone-complete unstarted check) and W017 (`:2107` orphan worktree, `:2127` stale worktree) each
cover two unrelated subjects under one code. W010 (×4), W020 (×3) and W022 (×3) are multi-branch but
share one subject and one remedy each, so they are legitimately one rule apiece — the distinguishing
test is subject identity, not message count.

### Decision 8. The diagnostic contract — *Required — Phases 9–12*

Added by Amendment 6, and **normative on the same terms as Decision 7**: where this section and the
code disagree the code is the defect; a behavior not stated here is not decided; amending a rule here
is a further amendment to this ADR. Decision 8 **consumes** §7.1–7.7 and does not restate or fork any
of them — in particular §7.7 already governs `state validate`'s unconditional `{valid: true}`, and
Decision 8 does not re-decide it.

#### 8.1 The subject a rule may read — *Enforced (Phase 10, #3308)*

**Question.** What may a diagnostic rule look at?

**Owner.** `src/planning-snapshot.cts` — a parsed projection of `.planning/`, composed from the §7 owners.

**Rule.**
1. A rule's signature is `(snapshot) => Diagnostic[]`. It receives no `cwd`, no `fs`, no other ambient I/O.
2. The snapshot exposes **parsed values, never raw document text.** This clause is load-bearing: given
   the text a rule can re-derive a field's location locally, which is the defect §7.7 removes one layer
   down. Given only the parsed value it cannot. The prohibition is structural, not advisory.
3. Every snapshot field carries its `scope` (Decision 2). A rule branches on `COMPLETE`-and-empty
   versus the three non-answers; it may not treat them alike.
4. Read failures are reported at construction via `warnUnusableInput` (the Unusable Input Diagnostic
   Module, #1879/#1883) and the field's `scope` is `UNREADABLE`. A rule never sees a plausible default
   standing in for a failed read. **That module is distinct from Decision 8:** it owns *I/O and parse*
   failure, whereas Decision 8's rules have no exception to catch — the read succeeded and the
   predicate was wrong.

#### 8.2 The diagnostic a rule emits — *Required — Phase 11*

**Question.** What is a finding?

**Owner.** `src/health-diagnostic.cts` — the `Diagnostic` value, the frozen remedy vocabulary, the rule
table, the evaluator.

**Rule.**
1. **One code = one rule = one subject.** A rule may vary its message with the data; it may not cover
   two subjects. A code identifies the *subject*, not the sentence.
2. **Codes are append-only and never renumbered.** A code is the only part of this contract a user
   carries away from the tool — into a troubleshooting page, a session log, an issue report — so
   renumbering is a silent break with no compensating benefit. Where one code currently covers two
   subjects, the second subject takes a **new** code.
3. **Severity and repairability are declared on the rule**, not passed at the emit call. They are
   properties of the finding class, and `health.md` has published them per-code all along; the code is
   what diverged.
4. A rule is a **function in a frozen table.** There is deliberately no declarative rule grammar, no
   condition mini-language, no precedence system, no string-dispatched predicate, and no user-authored
   rules. See *Software laws applied* — Greenspun's Tenth Rule is why this is written down rather than
   left to taste.

#### 8.3 The remedy — *Required — Phase 11*

**Rule.**
1. A remedy is a **value** — `{action, risk, args}` over two frozen enums — not a prose string. Adding
   a member is the repo's standard three coordinated changes: enum + emitting site + the test locking
   `Object.keys(...).sort()`, exactly as `PARITY_VIOLATION` and `UNUSABLE_REASON` do.
2. The vocabulary is **harvested, not invented.** `health.md`'s published repair-actions table already
   names **five** actions and classifies each by risk — `createConfig`, `addNyquistKey` and
   `backfillMilestones` are additive with no risk; `resetConfig` loses custom settings;
   `regenerateState` loses session history. Those five are Decision 8's first members and that column
   is its risk axis. Note the two non-trivial risks are the *only* two, so `DESTRUCTIVE` starts with
   exactly two members and the enum is not a speculative taxonomy.
3. A remedy that destroys user data or history declares `risk: DESTRUCTIVE`. **A `DESTRUCTIVE` remedy
   is describable but is never applied by `--repair`.** Risk classification is meaningless if the
   destructive members stay auto-runnable. W017's current remedy string is an untested
   `git worktree remove --force` (`verify.cts:2129`).
4. `--repair` dispatches a **closed enum with one hand-written handler per member.** It may not
   interpret an action specification — the Greenspun boundary again, on the apply side.
5. An advisory-only finding uses the `ADVISE` action with a command payload, so runtime-specific
   command formatting lives behind the value instead of inside every message string.

#### 8.4 The envelope — *Required — Phases 11–12*

**Rule.**
1. `validate.health`, `validate.consistency` and `state.validate` emit **one envelope** carrying
   `Diagnostic` values. Three renderings of one rule table is this ADR's own divergence, one level up.
2. `valid` and `passed` are **retained as derived booleans.** Both commands are published in
   `docs/COMMANDS.md` / `docs/CLI-TOOLS.md`, so a user script is conceivable even though the sweep
   found no in-repo consumer of either.
3. **`drift` is removed, not deprecated — and the asymmetry with rule 2 is deliberate.** `valid` and
   `passed` are scalars a script branches on. `drift` is a structured payload whose shape was never
   specified and whose populating branches sit behind the dead gate above, so in practice it has always
   been `{}`. Retaining an always-empty field is cargo, not compatibility. Its contents become coded
   diagnostics, which is strictly more information.
4. Neither `validate.consistency` nor `state.validate` may keep a private copy of a §7 derivation.
   `validate.consistency`'s disk-versus-roadmap comparison is §7.3's, and is why a sentinel-filter fix
   reaching only `validate.health` would be a fix landing on one copy.

#### 8.5 Proving a rule can fail — *Required — Phase 11*

**Rule.** Every rule carries a **known-bad fixture** that makes it fire, enforced by the same lint that
enforces 8.2's 1:1 invariant. A predicate whose failure arm is unreachable is output-identical to one
that passes — the Decision 3 failure mode, inside the diagnostic layer itself.

The fixture is bound to `CONTRIBUTING.md` § *Fixture provenance (#2371)*: it may not be derived from
the rule author's own model of the format. Without that binding this clause is a coverage percentage,
satisfiable by a fixture that trips the predicate trivially while never exercising the real condition.

#### 8.6 Turning an inert predicate live is a behavior change

**Rule.** A phase that makes a previously-unreachable predicate reachable **states the expected
new-finding volume on existing projects** in its PR. Such a rule has never fired, so every project it
now flags is a first-time report, and "the checker got noisier" is indistinguishable from "the checker
regressed" without the number stated up front.

#### Open question, recorded with a forcing function

**Does a diagnostic rule assert phase completion?** Not until Phase 4 (#3186) resolves #2957
(checkbox-override versus disk-strict). Decision 8 defines no completion rule, because a rule asserting
"this phase is done" would settle a product decision by typing order — the outcome Decision 5's
blocking note exists to prevent. Phase 4's guard fails while a third predicate exists, so this cannot
be routed around.

#### Software laws applied — re-run for Decision 8

The original run is in *Software laws applied* above; it ruled `conways_law` and `zawinskis_law` not
applicable. For Decision 8 three of the four fire again, one new law fires, and both of those two now
apply.

- **Greenspun's Tenth Rule — new, and it changed Decision 8.** A "rule table with predicates and a
  frozen remedy vocabulary" is one step from an ad-hoc rules engine. It clears only because rules stay
  **code**: ordinary functions in a frozen array, with no conditionals-as-data, no precedence, no
  string dispatch, no user-authored rules. That is exactly the line a later phase would cross by making
  rules declarative "so users can add their own", so 8.2 rule 4 and 8.3 rule 4 write the prohibition
  down instead of trusting taste.
- **Hyrum's Law — fired again, and found a gap.** Codes are the observable contract, hence 8.2's
  append-only rule. It also caught an unjustified asymmetry in the first draft of 8.4: `valid`/`passed`
  were retained for compatibility while `drift` was dropped, though all three are published in the same
  docs. 8.4 rule 3 now states the distinction rather than leaving it implicit.
- **Goodhart's Law — fired again.** "A known-bad fixture per rule" is structurally a coverage
  percentage and is gameable, hence 8.5's binding to fixture provenance.
- **Gall's Law — fired again, and produced 8.6.** Phases 10–12 replace a 907-line function, but
  incrementally and out of already-proven parts — the shape Phases 1–6 shipped six times. Its "preserve
  existing behavior until you understand why" clause is what 8.6 discharges.
- **Conway's Law — now applies.** 8.1 puts the snapshot in its own module rather than inside its first
  consumer, so the seam is not shaped around whichever surface happened to need it first.
- **Zawinski's Law — now applies**, and the evidence that scope was disciplined is the exclusion:
  `validate.consistency` and `state.validate` are in because they hold duplicate copies of §7
  derivations; `state.sync` is explicitly out because it is a writer.
- **Kernighan's Law** — 907 lines at complexity 28 is the violation Decision 8 removes; each predicate
  becomes individually testable against a literal object.

#### Phase index for the diagnostic layer

| Phase | Issue | Deliverable | Status |
|---|---|---|---|
| 9 | #3287 | this design lock (Decision 8) | docs-only |
| 10 | #3308 | `src/planning-snapshot.cts` (8.1) + `lint-planning-snapshot-bypass-drift.cjs`, ratcheted | PR pending (Amendment 9) |
| 11 | to file | `src/health-diagnostic.cts` (8.2/8.3/8.5), `validate.health` migrated, W021/W017 second subjects take new codes, `health.md` tables generated | follows Phase 10 |
| 12 | to file | `validate.consistency` + `state.validate` onto the envelope (8.4); `lint-planning-artifact-writer-drift.cjs` | follows Phase 11 |

**Ordering, and why it was not negotiable.** The set had to follow **Phase 5 (#3187)**: the snapshot's
current-phase field *is* §7.7's derivation, so building the snapshot first would have created a fourth
copy of the exact thing Phase 5 existed to consolidate — this ADR's own failure mode, committed inside
the fix for it. **Phase 5 merged 2026-08-09 (PR #3283), so that constraint is satisfied and Phase 10
is ready to file.** Phase 10 consumes `stateFieldValue` as its current-phase source; it does not
introduce a reader of its own. No phase-completion rule ships until **Phase 4 (#3186)** clears #2957.

**Copy counts are deliberately absent.** Amendment 4a's standing rule applies: each phase builds and
runs its guard **before** its scope is fixed, and states "N found by the guard", never "N per the
epic". `.planning/WINDOWS.md` is one confirmed registry miss; the real number is Phase 12's to report.
The scoped count has been wrong in every prior phase — 54 where the epic said 4 (Phase 3), three where
it said one (Phase 6).

**Coverage was verified mechanically before this decomposition was locked** — 24 decisions across 12
phases, every decision owned by exactly one phase, every hand-off landing in a phase that claims it,
and all five user-facing capabilities wired by an owning phase's acceptance criteria. The checker was
also run against a known-broken fixture to confirm it reports errors rather than passing vacuously —
the same discipline 8.5 imposes on the rules themselves.

**No recorded decision governed this seam.** `recall_decision` returns nothing for the health
diagnostic surface — the condition that made Phase 0 necessary, and the reason Decision 8 is locked
before Phase 10 rather than settled inside it.

### Amendment 7 — Phase 7 (#3217) validation: the contract held, on the second pass

**§7.6 rule 4 is now enforced.** A percentage is withheld (never rendered as a fabricated `0`) at
every consumer this phase reached: `roadmap analyze --json`'s `progress_percent`, `stats --raw`'s
`percent`/`plan_percent`, `query progress --raw`'s `percent`, `state json --raw`'s
`progress.percent`, and `state update-progress --raw`'s write. Rule 2's negative space — a **real**
`0` under a `COMPLETE` scope — is unaffected and still renders (matrix rows B1–B6).

**This phase was parked once and resumed after an isolated adversarial review, and the review
caught something a same-authorship pass would not have.** The first pass shipped rule 4 at
`computeProgressPercent` (§7.6's own "cheapest site" precedent) and at `cmdRoadmapAnalyze`'s new
`progressScope`-gated accumulation, but left `state.cts::buildStateFrontmatter` hardcoding
`SCOPE.COMPLETE` behind a written-reason comment ("threading it through would mean restructuring
the `_diskScanCache` shared shape, which is out of this phase's named sites"). The review rejected
the comment as a gate — "the whole finding is that a comment is not a gate" — and the restructuring
was done: `_diskScanCache`'s cached shape gained a `phaseDirScope: Scope` field carrying
`listMilestonePhaseDirs`'s real scope, threaded to the `computeProgressPercent` call site in place
of the hardcode. **A second defect surfaced only by tracing the fix through**, not named in the
original finding: the same function's prose fallback (`progressRaw.match(/(\d+)%/)`, reading a
`Progress: N%` line already written to STATE.md's body) fires whenever the scoped call returns
`null`, so a non-`COMPLETE` scope would still have surfaced a stale prose percentage through that
second path even after the hardcode was fixed. That fallback now also gates on
`diskScope === SCOPE.COMPLETE`, matching the pre-existing `milestoneUnbounded` guard already beside
it (#1761). **Generalized lesson, in the same family as Amendment 5's "any numeric window in a drift
guard is a Goodhart target": a rule-4 fix at one output expression is not enough when a fallback
expression sits beside it and shares the same "no data" `null` sentinel — every path that can
produce the observable output must be re-checked, not just the primary one.**

**A second, independent scope was found ungoverned at `cmdRoadmapAnalyze` and is now exposed, not
reconciled.** `roadmap analyze --json` computes `progress_percent` from its own
`listMilestonePhaseDirs` call (`progressScope`) — correctly, per rule 3 — while `total_plans` /
`total_summaries` / `phases` / `completed_phases` stay derived from the heading-matched
`_phaseDirNames` scan that the top-level `scope` field (windowing identity) describes. Two `Scope`
values governed one JSON object and only one was named. Of the three options the review posed
(expose the second scope; reconcile the two into one; re-derive the phases/counts fields from the
same scoped set as the percentage), this phase **exposes** it as a new `progress_scope` field rather
than reconciling or re-deriving. Reconciling or re-deriving would have undone the phase's own
already-recorded, deliberate choice a few lines above it in the same function — "this does not touch
`total_plans` / `total_summaries` / `phases` / `completed_phases` … only `progress_percent`'s own
inputs move onto the scoped owner" — which exists because `_phaseDirNames` is a heading→directory
**lookup index**, not a milestone enumeration, and filtering it through `listMilestonePhaseDirs`
would scope the same set twice (the same shape Decision 4a's exemption already covers for that
variable). Exposing the field that governs the null is the minimal change that satisfies the
invariant the review named: *a consumer must be able to tell WHY a percentage is absent from the
JSON alone.*

**A third, minor finding — `state update-progress`'s silent no-op — is resolved as accept-with-
disclosure, not silence.** The command already left `STATE.md` untouched on a non-`COMPLETE` scope;
the gap was that the only signal was a JSON `reason` field most callers do not read. It now also
writes a `[gsd-tools] WARNING:` line to stderr, matching the convention this same file already uses
for a comparable silent field-update no-op (`stateReplaceFieldWithFallback`, `state.cts:553`) rather
than inventing a second warning shape.

**The guard question was re-litigated, not skipped.** Issue #3217 asked for
`lint-completion-ratio-drift.cjs` to be extended to "catch a percentage rendered from counts whose
scope was not consulted." A narrow, syntactic candidate — a call to `listMilestonePhaseDirs(...)`
whose `.value` is read while `.scope` is never bound in the same function — was prototyped against
the real tree and produced real false positives: `src/milestone.cts:697,753,881` legitimately read
only `.value` from that call for milestone **archiving**, unrelated to percentage rendering at all.
"Was this scope consulted before rendering a percentage" is a data-flow question, not a syntactic
one, and no syntactic proxy distinguishes those two call shapes. Per Amendment 4a's standing rule —
build and run before scope is fixed, state what the guard actually found — the candidate was dropped
rather than shipped with an exemption list that would have hollowed it out on the sites it exists to
catch. **The existing arithmetic guard (rules 1–2) is unchanged and still reports an earned `0`** on
the real tree (test row E3); the real enforcement for rule 4 is the behavioral identity-at-the-
surface suite this phase adds (`tests/completion-ratio-scope-withholding.test.cjs`, matrix rows
A1–A11, B1–B6, C1–C3, D1–D4, E1–E4), per Decision 4(b)/(c) — asserted at each consumer's observable
output, never at a helper's return value, so a percentage post-filtered after the fact cannot pass
as one never withheld.

**What this phase does NOT close, left with a written reason rather than silently dropped:**

- **Workstream inventory (matrix row A8).** `buildWorkstreamInventory`
  (`src/workstream-inventory-builder.cts`) carries a pre-ADR-3180 bespoke boolean
  (`milestoneScoped`), not the frozen `SCOPE` enum, and cannot distinguish `TRUNCATED` from
  `UNSCOPED` from `UNREADABLE`. Migrating it honestly requires widening
  `WorkstreamInventory.progress_percent` from `number` to `number | null` — a return-type
  re-architecture the design doc names as out of scope for this phase — or reusing the bespoke
  boolean as a `Scope` stand-in, which is the same textual-proxy-for-a-data-flow-property this
  amendment's guard section rejects one paragraph up. Left un-migrated with the reason recorded at
  the field's own definition site.
- **`cmdStateSync`'s own `SCOPE.COMPLETE` hardcode (`state.cts`, `cmdStateSync`), found but not
  named in the original review.** This is a *third* site sharing buildStateFrontmatter's pattern —
  a raw `fs.readdirSync(phasesDir, ...)` listing, never routed through `listMilestonePhaseDirs`,
  carries its own written-reason comment for staying on `SCOPE.COMPLETE`. It was not named as a
  finding and the design's consumer map does not list `cmdStateSync` among the sites this phase
  owns. It is lower-risk than the fixed sites: an unreadable `phasesDir` (this finding's own
  reproduction shape) already hits `cmdStateSync`'s own `fs.readdirSync` `catch` block, which exits
  via the pre-existing `{ synced: true, changes: [], dry_run }` early return **before** any percent
  is computed — so the specific defect this phase closes elsewhere does not reproduce here. Recorded
  rather than silently left for a reader to independently rediscover; migrating it fully (adding rule
  3's window-scoping, not just rule 4's withholding) is out of this phase's named scope.

**Rebase note.** This phase's implementation predates Phase 4 (#3186, the disk-strict completion
predicate) landing on `next`. Rebasing onto `next` after Phase 4 merged produced **no conflicts**,
though Phase 4 turned out to touch two of the same functions this phase's fix reaches —
`buildStateFrontmatter` and `cmdStateSync` — swapping each one's `diskCompletedPhases` count from
`scanPhasePlans(...).completed` (answers "are all plans summarized", a different question, per
§7.4/#2957) to the canonical `isPhaseComplete(...).value.complete`. Those hunks land in the
phase-directory completion-counting loop in each function; this phase's own hunks land at the
`listMilestonePhaseDirs` destructure, the `_diskScanCache` shape, and the `computeProgressPercent`
call site further down the same functions — non-overlapping line ranges, which is why the automatic
merge succeeded with no manual resolution.

**Tier-2, re-derived for Phase 7 (mirrors Amendment 5's per-phase table convention):**

| Command surface | Output change |
|---|---|
| `roadmap analyze --json` | `progress_percent` becomes `number \| null`; gains a new `progress_scope` field naming the scope that governs it, separate from the top-level `scope` |
| `stats --raw` | `percent` and `plan_percent` become `number \| null` |
| `query progress --raw` | `percent` becomes `number \| null` |
| `state json --raw` | `progress.percent` is omitted (not `0`, not `null`) rather than rendered when the underlying scope is not `COMPLETE` |
| `state update-progress --raw` | unchanged wire shape (`updated: false` was already the non-write signal); gains a `[gsd-tools] WARNING:` stderr line on skip |

**Guard roster (§7.6 row), as amended.** The original body's row is not edited in place, per
Amendment 6's own precedent; read with this correction: `lint-completion-ratio-drift.cjs`'s scan
surface and mechanism are **unchanged** (arithmetic rules 1–2 only, `src/` scan surface) — rule 4 is
enforced by the behavioral suite named above, not by an extension to this guard. §7.6's status line
("rule 4 Required — Phase 7") and the Status bullet "Rule 4 — Phase 7 (#3217)… is not implemented
anywhere" are superseded by this amendment: rule 4 is enforced at every site Phase 7 named, with the
two written exceptions above.

### Amendment 8 — a BLOCKER correction to Amendment 7's `cmdStateSync` claim: TRUNCATED and UNSCOPED row 4 DID reproduce

**Amendment 7's second "what this phase does NOT close" bullet is wrong and is corrected here, not
silently rewritten** — per Amendment 6's own append-only precedent, that bullet's body is left
untouched above; this amendment records what independent, empirical reproduction on fresh fixture
copies actually found.

Amendment 7 claimed `cmdStateSync`'s hardcoded `SCOPE.COMPLETE` was "lower-risk than the fixed
sites" because "an unreadable `phasesDir` (this finding's own reproduction shape) already hits
`cmdStateSync`'s own `fs.readdirSync` `catch` block… so the specific defect this phase closes
elsewhere does not reproduce here." That checked only the `UNREADABLE` row. It did not check
`TRUNCATED` or `UNSCOPED`, and on those rows the claim is false: `cmdStateSync`'s disk scan
(`entries`, `state.cts` ~3113) enumerates `phasesDir` successfully — it is readable — but the scan is
**unfiltered by the real milestone window** (it only excludes retired phase numbers, #1514), and the
percent gate hardcoded `SCOPE.COMPLETE` regardless of what the real window's scope was. Reproduced on
fresh, independent fixture copies (`listMilestonePhaseDirs` called directly to confirm the real
scope, matching each surface's own derivation):

| fixture | real scope | `state sync` (pre-fix) |
|---|---|---|
| TRUNCATED (milestone heading found, window empty, document has phases elsewhere — row 8) | `truncated` | **wrote a fabricated `0%` → `100%`** |
| UNSCOPED row 4 (no milestone asserted, ROADMAP has versioned headings) | `unscoped` | **wrote a fabricated `0%` → `100%`** |
| UNSCOPED row 5 (asserted version, no matching heading) | `unscoped` | skipped — but only because the orthogonal `milestoneBounded` (#1761) guard happens to intercept this specific row first, not because `cmdStateSync` itself was scope-aware |

Worse than a wrong read: this is a **write** path, and on the TRUNCATED fixture it persisted a
self-contradictory `STATE.md` in one write — the body's `Progress:` line got the fabricated `100%`
while the frontmatter's `progress:` block, built in the same `writeStateMd` call by the already-fixed
`buildStateFrontmatter`, correctly omitted `percent`. That cross-surface disagreement inside a single
file is the exact defect class this epic exists to remove.

**Fixed the same way as the two sites Amendment 7 named**: `cmdStateSync` now calls
`listMilestonePhaseDirs(phasesDir, { cwd, versionOverride: versionStr })` — reusing the same
`syncRoadmapRaw`/`syncRoadmapScope` already parsed in the function for the disk-scan totals — and
withholds (pushing a `Progress: skipped — …(#3217)` entry to `changes`, mirroring the `#1761`
skip-message convention already at that call site) whenever the real scope is not `COMPLETE`. The
`milestoneBounded` (#1761) guard is unchanged and still fires first on row 5; a genuine `0` under a
real `COMPLETE` scope still writes. Re-reproduced post-fix: all three rows above now agree with
`state json` / `roadmap analyze` / `stats` / `query progress` on the same fixture — all withhold
together, none renders a number, and the control (`COMPLETE`) fixture still writes its earned
percentage.

**Generalized lesson — the second instance of this pattern in this epic (see Amendment 5's own
"Goodhart target" lesson for the first).** A "does not reproduce" claim was too generous a second
time: it checked the row named in the ORIGINAL finding (`UNREADABLE`) and stopped, rather than
checking every row the same code path could plausibly hit. A written-reason comment recording "I
checked X and it's fine" is not evidence about Y and Z unless Y and Z were checked too — the same
"a comment is not a gate" principle Amendment 7 itself invoked against `buildStateFrontmatter`'s
original hardcode applies equally to a comment that scopes its own non-reproduction claim too
narrowly.

**Tier-2, additional (mirrors Amendment 7's own table):**

| Command surface | Output change |
|---|---|
| `state sync --raw` | on a non-`COMPLETE` scope: no `Progress:` body rewrite; `changes` gains a `Progress: skipped — …(#3217)` entry instead. A genuine `0` under `COMPLETE` is unaffected. |

`.changeset/bold-otters-scope.md` is updated to disclose this write-path change alongside the two
Amendment 7 already recorded.

### Amendment 9 — Phase 10 (#3308) validation: the guard's real baseline, not the issue's estimate

Phase 10 (`src/planning-snapshot.cts`, PR pending) shipped the diagnostic subject §8.1 specifies:
`buildPlanningSnapshot(cwd)`, a parsed projection of `.planning/` composed **exclusively** from the
already-consolidated §7 owners — `getMilestoneInfo`, `listMilestonePhaseDirs`, `isPhaseComplete`,
`scanPhasePlans`, `stateFieldValue`, `planningPaths`. It introduces exactly one new piece of
coordination logic: `worstScope(...scopes)`, a severity-ordered combinator (`COMPLETE` best,
`UNREADABLE` worst) folding several independently-scoped owner answers into one composite `Scope`
per phase record. This is not a re-derivation of any owner — each input `scope` is already that
owner's final verdict; `worstScope` only picks the worst of several finals, which is new coordination
no single §7 owner has visibility to express on its own.

**The guard's real baseline, per Amendment 4a's standing rule ("N found by the guard, never N per
the epic").** The ratcheted guard `scripts/lint-planning-snapshot-bypass-drift.cjs`, scoped to
`DIAGNOSTIC_RULE_FUNCTIONS = {src/verify.cts: {cmdValidateHealth}}`, found **15 distinct (file, text)
raw-read sites, 21 total acknowledged occurrences** inside `cmdValidateHealth`
(`scripts/baselines/planning-snapshot-bypass-baseline.json`). Contrast this against the epic's own
code-COUNT estimate: `cmdValidateHealth` is described, both in the issue and in this ADR's own
Amendment 6 (§ *Why the diagnostic layer is the same failure class*), as emitting "30+" diagnostic
codes through one nested `addIssue` closure — a figure about how many **codes** the function emits,
not how many **raw-read call sites** produce them. The two are different measures, exactly as
Amendments 2/3/4/7 found for their own derivations: a code-count estimate is not a call-site count,
and the whole-repo, function-scoped guard is what makes the real number visible instead of assumed.
The gap runs the expected direction — several codes share a read (`configRaw`'s
`fs.readFileSync(configPath, 'utf-8')` alone accounts for 4 of the 21 occurrences) — so 15 sites
covering 21 occurrences behind 30+ codes is consistent with, not contradictory to, the epic's figure.

**The contract held on the first pass.** No amendment to §8.1 rules 1–4 was needed. Rule 2 — parsed
values only, never raw text — is what the guard now mechanically enforces going forward for any
**new** diagnostic-rule-shaped code: an unrecorded raw-read site inside a `DIAGNOSTIC_RULE_FUNCTIONS`
entry fails lint immediately. `cmdValidateHealth`'s existing 15 sites are ratcheted debt explicitly
owned by Phase 11 (#3309), not silently left unwatched — the baseline can only shrink, and a site that
stops firing without being pruned from the baseline also fails, per Decision 4(e)'s invariants.

**One open judgment call, surfaced for a maintainer's eyes rather than silently resolved — not a
defect, per this ADR's own "written rule, not silent implementation choice" philosophy.** §8.1 rule 4's
text ("Read failures are reported via `warnUnusableInput`... and the field's `scope` is `UNREADABLE`")
could read as implying every `UNREADABLE` scope correlates with a reported diagnostic. Phase 10's
`currentPhaseLabel` field (`buildCurrentPhaseLabel`, `src/planning-snapshot.cts`) treats a genuinely
**absent** STATE.md as `UNREADABLE` too, but does **not** call `warnUnusableInput` for that case — only
an actual read error (e.g. EISDIR) fires it. This mirrors §7's own absence-vs-corruption distinction
elsewhere in this ADR (e.g. the `unusable-input.cts` glossary entry's `#1881` note on ROADMAP.md): a
project that never ran `state.init` legitimately has no STATE.md yet, and that is a non-answer, not
corruption. Recorded as the intended reading rather than a gap, since it is symmetric with how every
other §7 owner already treats absence vs. unreadable.

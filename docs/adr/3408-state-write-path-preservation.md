# ADR-3408: STATE.md Write Path — One Declared Policy, One Write Seam

- **Status:** Accepted. Phase 0 ships this file alone; every rule in §8 is *Required — Phase N* until its phase lands.
- **Date:** 2026-08-14
- **Issue:** [#3408](https://github.com/open-gsd/gsd-core/issues/3408) is the **scope authority** (`epic` + `approved-enhancement`), which is why this ADR carries its number. [#3467](https://github.com/open-gsd/gsd-core/issues/3467) is the Phase-0 tracking sub-issue this PR closes — the epic stays open until Phase 4 merges. Convention follows [ADR-3180](3180-planning-semantic-model-single-owner.md) and [ADR-3128](3128-adaptive-runtime-evidence.md).
- **Supersedes:** nothing.
- **Relationship to prior work:** the **write-side mirror** of [ADR-3180](3180-planning-semantic-model-single-owner.md), which gave each read-side derivation one owner and proved it with drift guards. Every owner in ADR-3180 §7 is a read derivation; no ADR owns the write path. This applies the same mechanism to it, and adopts ADR-3180's Decision 4 constraints (a)–(e) verbatim rather than restating them.

Symbol names are the durable anchors throughout. Line references are as of `next` @ `5452f1a70` and will drift.

## Context

`src/state-transition.cts` declares a per-field preservation policy in `FIELD_CLASSIFICATION`, and its docstring states the contract:

> Adding a new STATE.md field = one row here, not 9 transition edits.

`applyStatePreservation` — the function that consumes the table — half keeps that promise, and the half it does not keep is where six confirmed-bug instances live.

### The divergent surface

| Concern | Declared | Enforced | Divergence |
|---|---|---|---|
| `preserve-when-unchanged` for `current_phase`, `current_plan`, `paused_at`, `last_activity_desc` | `FIELD_CLASSIFICATION` | a generic table loop (#3258 / PR #3447) **plus** empty-only "#905" guards in `syncStateFrontmatter` on the `writeStateMd` / `cmdStateJson` paths | two enforcement points that "agree by construction" per a 19-line code comment |
| `preserve-when-unchanged` for `status`, `stopped_at` | `FIELD_CLASSIFICATION` | two hand-written `if` blocks | policy change is not a one-row table edit |
| `preserve-always` for `current_phase_name`, `progress` | `FIELD_CLASSIFICATION` | two hand-written `if` blocks | as above |
| `derive`, `clear` | `FIELD_CLASSIFICATION` / the `FieldPreservation` union | **no executor at all**; `clear` has no row either | a declared policy nothing implements |
| the write seam itself | `readModifyWriteStateMd` | plus a direct `syncStateFrontmatter` call in `cmdPhaseComplete`, and `stateReplaceField` over frontmatter in `patchCore` | two writers outside the policy |
| what a command *reports* it wrote | — | an intent list captured before sync | never reconciled against what was persisted |

### The failure mode that hides all of it

This is ADR-3180's signature shape, on the write side: **the failure and the success are output-identical.**

| Path | Returns on failure | Issue |
|---|---|---|
| a declared row whose caller wired no body-source delta | `continue` — indistinguishable from a policy that correctly did nothing | the #3258 class |
| `phase.complete` harvesting a stale body `Stopped at:` | a well-formed `stopped_at` naming phase N−1, `warnings: []` | #3374 |
| `state.planned-phase` re-deriving `current_phase` from stale body prose | a well-formed `35.1` where the caller passed `35.3` | #3395 |
| `phase.complete` overriding `current_phase_name` only | a well-formed pair describing two different phases | #3350 |
| `state.patch` reporting fields it did not persist | `{"updated":[…],"failed":[]}`, and the file *was* rewritten so mtime/hash/`git diff --quiet` all agree | #3351 |

Every row is a plausible value no caller can distinguish from a real one. #3258 is the proof the trap works as designed: a careful reporter read the table, correctly identified an unimplemented row, and filed #3234 for a symptom that does not occur — because the policy was enforced ~1300 lines away in a different module.

### Why a contract, and not six point fixes

The shape is **"policy declared in a table, enforcement hand-rolled per call site."** A row can be added and nothing objects if no branch implements it. Fixing the instances individually leaves the seventh free to land — and ADR-3180's §7 preamble states exactly why a written rule is the missing piece:

> a reviewer with no written rule to check a call site against can only ask "does this look like the others", which is how a fifth copy passes review.

That reasoning held three consecutive times on the read side: ADR-3180's phases found **26** copies where the epic scoped 3, **5** where it scoped 3, and **54** where it scoped 4.

## Decision

### 1. One executor per declared policy — dispatch on the row, not the field

`applyStatePreservation` selects its branch from the row's `preservation` value. Every member of the `FieldPreservation` union has exactly one implementation:

| Policy | Executor |
|---|---|
| `preserve-when-unchanged` | restore the pre-write snapshot when the field's body source did not change in this write |
| `preserve-always` | restore the pre-write snapshot, subject to the row's guards |
| `preserve-if-placeholder` | restore when the derived value is absent, the template placeholder, or punctuation-led |
| `derive` | explicit no-op — the sync's value stands |
| `clear` | remove the field, **or** the union member is deleted (Phase 1 decides; see §8.6) |

`derive` gets an executor precisely *because* it is a no-op: naming it is what lets Decision 2 tell "policy says do nothing" apart from "nobody wired this."

**Field-specific guards are row metadata drawn from a CLOSED vocabulary.** `status`'s `'unknown'` sentinel and `stopped_at`'s `## Session` body scoping become named guards the executor interprets — not a reason for a hand-written branch, and **not an open predicate slot.**

*Rejected: an open per-row `guard` predicate.* It is the most natural next edit and the one that converts the table into an interpreter. Greenspun's Tenth Rule, applied to a table that has already accreted five times (`preserve-always` #1743/#1695, `preserve-if-placeholder` #948/#2135, `state_head` #2573, `deriveProgressKeys` #2440, `bodyDeltas` #3258). **Adding a guard kind is an amendment to this ADR, not a table edit.**

*Rejected: keep the hand-written branches, better documented.* That is the status quo, and `src/state-transition.cts:287-305`'s reconciling comment is the evidence that documenting a hand-written branch does not bind the next one. ADR-3180 Decision 1 on "keep in sync" comments applies verbatim: *"it is evidence the risk was known, not that it was controlled."*

### 2. An unenforced declared row is a LOUD failure — and this line does not extend to user documents

A declared `preserve-when-unchanged` row reaching the executor with no wired body-source delta **throws**. Today it is `if (!delta) continue` (`src/state-transition.cts:314`) — silently unenforced at runtime, caught only by an invariant test.

**The bright line, stated because conflating its two sides would be severe:**

| Bad input | Response |
|---|---|
| **Internal invariant violation** — a declared row with no caller wiring | **throw.** Both ends are gsd-core's own source; it is a programming error, unreachable from any user document |
| **User-document defect** — a drifted, malformed, or unparseable STATE.md | **never throw.** Preserve per policy and *warn*; behavior otherwise unchanged |

ADR-3180 Decision 2 rejected throwing, reasoning that "these paths are read during normal progress rendering, and throwing converts a display degradation into a command failure." That is correct **for external input** and is preserved here for the second row. It does not govern the first: Postel's own guidance for internal system-to-system boundaries, where both ends are controlled, is stricter on both sides.

Getting this backwards would turn every desynced project's `phase.complete` into a hard failure. It is a rule, not a note.

### 3. One write seam — a pure pipeline plus an I/O wrapper

`readModifyWriteStateMd`'s sync + preservation stage is extracted into a **pure `content → content` function**. `readModifyWriteStateMd` becomes that function plus its read / lock / no-op-guard / write envelope.

This is what makes "one write seam" achievable without breaking anything. `cmdPhaseComplete` bypasses the seam today for a **legitimate** reason its own comment gives (`src/phase.cts:2953-2957`):

> it does NOT go through readModifyWriteStateMd because STATE.md is committed atomically with ROADMAP/REQUIREMENTS

`writePlanningFileSet` commits three files as one unit. **Deleting the call site outright would trade a preservation bug for an atomicity bug.** Calling the pure pipeline gives the command its atomic write *and* the policy.

`patchCore` stops running `stateReplaceField` over frontmatter (`src/state-transition.cts:1600-1601`), unlike `updateCore`, which already strips it first (`:1631`) and is the correct shape.

**A caller needing a different I/O envelope calls the pipeline. It never re-assembles one.** Assembling the stages at a call site is a re-derivation even when every step calls the owner — ADR-3180 Amendment 2 found exactly that shape on the read side, where two sites re-assembled a window from the owner's primitives and had already diverged.

### 4. Report from `postFm`, after preservation

Every `updated` / `failed` / `warnings` array a command returns is computed **after** `applyStatePreservation`, by comparing persisted frontmatter against the pre-write snapshot. A field appears in `updated` iff its persisted value changed.

"Reported but not persisted" (#3351) and "persisted but not reported" (#3345) both become unrepresentable.

This matters more than a cosmetic report: #3351 records that the file *is* still written — `last_updated` is bumped — so mtime, hash and `git diff --quiet` all confirm the lie. The `updated` array is the only field-level signal a caller has.

### 5. The anti-divergence contract — and how its metric is gamed

`scripts/lint-state-write-path-drift.cjs` reports **0 write-path bypasses**, paired with a behavioral identity test asserting at the **consumer's** output. ADR-3180 Decision 4 (a)–(e) is adopted verbatim and not restated.

"0 bypasses" is a measure about to become a target. The routes are enumerated here so a future reader can check a green guard against them:

| Gaming route | Defense |
|---|---|
| Scan only `src/` | 4(d) — the scan surface is **declared** and includes the prompt layer (`gsd-core/workflows`, `commands`, `agents`, `skills`), which can shell out to `state.patch` and post-process |
| Route the bypass through a wrapper or a differently-named local | 4(b) — the paired behavioral test |
| Call the pipeline, then mutate `postFm` locally | 4(c) — assert at the **consumer's** output, never the owner's return value |
| Exempt the owner file | 4(d) — owner **functions** are exempt; the owner **file** is not. ADR-3180 Amendment 4 records a whole-file owner exemption failing in `roadmap-parser.cts`; the risk transfers here because `state.cts` is likewise both the owner and the largest bypass surface, which is this ADR's extrapolation rather than a fact ADR-3180 states |
| Bank every site in the ratchet and never shrink | `qa-smell-ratchet.cjs` invariants: a recorded site that no longer fires **also** fails; each phase shrinks the baseline by exactly its removals; each entry names the issue owning its removal |
| Write the guard last, against an already-clean tree | **The guard ships in Phase 1, ratcheted.** ADR-3180 Amendment 5 is titled *"the guard nearly reported a zero it had not earned"* |

**"0 bypasses" is a lagging output metric.** The leading indicator is the ratchet's shrink matching each phase's removals, and the identity test's consumer coverage. **Neither number is ever reported alone** — 4(b)'s constraint, made explicit here rather than inherited, because reporting the zero by itself is the whole failure mode.

Per ADR-3180 Amendment 3's standing rule, each phase states its copy count as **"N found by the guard", never "N per the epic."**

### 6. Migration order — the guard first, the seam second

**Locked:** Phase 0 (this ADR) → Phase 1 (executor + ratcheted guard, [#3468](https://github.com/open-gsd/gsd-core/issues/3468)) → Phase 2 (one write seam, [#3469](https://github.com/open-gsd/gsd-core/issues/3469)) → Phase 3 (report from `postFm`, [#3470](https://github.com/open-gsd/gsd-core/issues/3470)) → Phase 4 (stale-but-present + identity test + ratchet to 0, [#3471](https://github.com/open-gsd/gsd-core/issues/3471)).

Stacked and sequential, never parallel: `get_impact(direction=both, depth=6)` against `next` rates `readModifyWriteStateMd` **CRITICAL** (185 affected symbols, lower bound; 38 files; 25 processes) and `syncStateFrontmatter` **CRITICAL** (154). Every symbol these phases name sits inside one blast radius, so a parallel phase would edit symbols inside a sibling's.

Phase 3 follows Phase 2 because it reports on the pipeline Phase 2 makes canonical. Phase 4 is last because its ratchet-to-zero is only meaningful once Phases 1–3 have shrunk it.

### 7. Scope boundaries

**In scope:** the five concerns in §8; the guard and identity test; boundary coverage per `CONTRIBUTING.md`; at least one test per concern asserting the path **can** fail.

**Out of scope:** `.planning/` on-disk formats; the document-parsing layer (#2143); concurrency and cross-process atomicity (#3311 — a different failure mode needing locking, not a preservation table; `6b34557ba fix(#3311)` landed independently).

**The child defects.** Phases 1–4 drive #3258, #3374, #3350, #3351 and #3395 fail-first. Following ADR-3180 §6's precedent, each phase **names** the issues it subsumes and records the evidence the symptom is gone; it does **not** unilaterally close them. Whether a subsumed issue is closed, re-scoped, or kept open for its own regression test is the maintainer's call at merge time, made with the evidence in front of them.

Recording it explicitly because both silences are failures: a phase that demonstrably removes a defect's symptom while claiming to change nothing is a shipped lie, and a phase that closes an issue the epic disclaimed is scope it never had.

### 8. The behavior contract — THIS SECTION IS THE SOURCE OF TRUTH

Decisions 1–7 answer *how* the write path is organized. This section says *what the right answer is*, and it is what the guards and identity tests of Decision 5 test **against**.

- **Where this section and the code disagree, the code is the defect** — not this section, and not a caller's local expectation.
- A behavior not stated here is **not decided**. It is recorded as an open question with a forcing function, never resolved silently inside an implementation PR.
- Amending a rule here is an amendment to this ADR, not a code change with a comment.
- Each rule carries a **status**: *Enforced* or *Required — Phase N*. A *Required* rule is as binding as an *Enforced* one; the only difference is whether the tree satisfies it yet.

#### 8.1 Policy dispatch — *Required — Phase 1*

**Question.** Given a STATE.md field and its `FIELD_CLASSIFICATION` row, what decides its value after a write?

**Owner.** `src/state-transition.cts` · `applyStatePreservation`, dispatching on `row.preservation`.

**Rule.** Exactly one executor exists per `FieldPreservation` member. No branch is selected by field name. Field-specific conditions are named guards from a closed vocabulary; a new guard kind is an amendment to this ADR.

**Failure signal.** §8.2.

#### 8.2 An unenforced row — *Required — Phase 1*

**Rule.** A declared `preserve-when-unchanged` row reaching the executor with no wired body-source delta **throws**. This applies to internal invariant violations only. A user document that is drifted, malformed, or unparseable **never** throws — §8.5 governs it.

**Rule.** Where both conditions hold at once, the invariant violation is reported first: it is a defect in our source, and reasoning about the user's document under a broken policy table is meaningless.

#### 8.3 The write seam — *Required — Phase 2*

**Question.** What is allowed to write STATE.md?

**Owner.** `src/state.cts` · the pure sync + preservation pipeline, and `readModifyWriteStateMd` as its I/O wrapper.

**Rule.** Every STATE.md write applies the pipeline **unless the command's own contract is to let the body win** (see the exception list below). A caller needing a different I/O envelope — `cmdPhaseComplete`'s atomic three-file commit via `writePlanningFileSet` — calls the pipeline and supplies its own envelope. It does not re-assemble the stages, and it does not skip them. Assembling the stages at a call site is a re-derivation even when every step calls the owner.

**Sanctioned permanent exceptions — a closed list; adding to it is an amendment.** Preservation makes curated frontmatter win over a re-derived body value. Two commands exist precisely to do the opposite, and applying the pipeline to them would invert the feature rather than fix a bug:

| Command | Why preservation must NOT apply |
|---|---|
| `state sync` (`cmdStateSync`) | Its contract is #905's *"body annotation beats existing frontmatter when both are present"* — `sync` exists to re-derive frontmatter **from** the body. A preservation pass re-locks the stale frontmatter the command was invoked to replace. |
| `/gsd-health --repair`'s `REGENERATE_STATE` | A factory reset that rebuilds STATE.md from scratch. Preservation would restore exactly the values it was invoked to discard. |

Both are **permanent entries in the ratchet with `owner: sanctioned-permanent`**, never debt. A guard reporting them is reporting correctly; a change that removes one is a regression, not progress.

*This paragraph is Amendment 2. The rule previously read "Every STATE.md write applies the pipeline", which is false by design for both rows and would have had Phase 2 route `cmdStateSync` through preservation — inverting a shipped feature with every gate green.*

**Rule.** `current_phase` and `current_phase_name` are written as a **pair**. A transaction that computes one from a phase number writes both from that same number, so the two cannot describe different phases (#3350).

**Consumers that must route through the owner.** `readModifyWriteStateMd`'s 16 callers, `cmdPhaseComplete` (`src/phase.cts`), `patchCore` and `updateCore` (`src/state-transition.cts`), plus the three direct `writeStateMd` callers a whole-repo scan finds: `cmdStateSync` (`src/state.cts:3682`), `cmdMilestoneComplete` (`src/milestone.cts:865`), and the `REGENERATE_STATE` remedy (`src/health-diagnostic.cts:337`). Each is a **named ratchet entry** carrying the issue that owns its removal, never an unrecorded pass.

**`REGENERATE_STATE` is a sanctioned permanent exception, not debt.** It is `/gsd-health --repair`'s factory reset: it backs up STATE.md, then rebuilds the document from scratch (`src/health-diagnostic.cts:313-339`). Preservation would defeat its entire purpose — restoring the curated values it was invoked to discard. It is recorded here so a future reader does not "consolidate" it, and so the guard's baseline can never silently absorb it.

> **How this list was gotten wrong once already, recorded because it is the exact trap this ADR exists to close.** `CONTEXT.md`'s STATE.md Transition Module entry placed the factory-reset primitive at `verify.cts:1925`. It is not there — it moved to `health-diagnostic.cts` when `cmdValidateHealth` migrated onto the rule table (`d1760e3c3 refactor(#3309)`), and `src/verify.cts` now contains no `writeStateMd` call at all, only two stale comment references at `:1332` and `:1364`. **The design intent that entry recorded was correct; only its address was stale** — and a first pass at this ADR, trusting the entry, over-corrected in the opposite direction and reported the primitive as retired. The entry is fixed in this PR.
>
> Two rules follow, and they are why this box is normative rather than a footnote:
>
> 1. **Phase 1's guard derives its baseline from a whole-repo scan, never from this list or from `CONTEXT.md`.** The list exists to be checked *against* the scan; a discrepancy is the scan's finding, not the list's.
> 2. **A stale address does not retire a decision.** Read the code before concluding a recorded exception is gone — ADR-3180 Amendment 3's lesson, which this PR proceeded to demonstrate on itself: *"Read the code, not the write-up."*

**Guard.** `scripts/lint-state-write-path-drift.cjs`.

#### 8.4 The report — *Required — Phase 3*

**Question.** What does a command's `updated` / `failed` array mean?

**Rule.** It names the fields whose **persisted** value changed, computed from `postFm` after preservation. A field the caller asked for that did not change is not `updated`. Whether "not found" and "found, written, then restored by policy" are distinguishable buckets is **decided in Phase 3 and recorded as an amendment here** — it is a behavior this section does not yet state, so per §8's own rule it is not decided.

#### 8.5 Stale-but-present — *Required — Phase 4*

**Question.** The body source disagrees with frontmatter and the derived value is non-empty. Who wins?

**Rule.** The declared policy decides, on the same terms as an empty derived value. `preserve-when-unchanged` restores the curated frontmatter value when that field's body source did not change in **this** write.

**One enforcement point on the write seam — with the §8.3 exceptions carved out explicitly.** The empty-only "#905" guards in `syncStateFrontmatter` are **gated, not deleted** (corrected by Amendment 3): they stay active for the two sanctioned-permanent exceptions, which never run `applyStatePreservation` and for which those guards are the *only* empty-field fallback, and are off on the write seam where the executor owns the empty case.

**Rule — a discard is as visible as a restore.** When the body source *did* change this write and the derived value is empty, the derived value wins per the delta rule and the curated value is dropped. That drop is reported through the same channel as a restore. Silence would make "preservation is visible" true only for the half of the rule that adds a value back.

**Rule — `cmdStateJson` is governed too.** It is a read path, and it carried its **own private copy** of the empty-only guards with no delta check at all. It routes through the executor's `preserve-when-unchanged` rule instead. *(This section previously described those guards as living "in `syncStateFrontmatter`". They did not — they were a separate third encoding, corrected by Amendment 3.)*

**Rule.** **Preservation is visible.** When policy restores a curated value over a disagreeing derived one, the command emits a divergence warning. Silence is the defect #3374 reported (`warnings: []`), not the fix.

**Rule.** A drifted body is an ordinary, expected user-document state. It is what this contract preserves against — never an error, never a throw (§8.2).

#### 8.6 `clear` — *OPEN QUESTION, forcing function: Phase 1*

`clear` is a declared `FieldPreservation` member. **No row uses it and no executor exists.** That is §8.1's defect one level up: a declared policy nothing implements.

Phase 1 either implements and tests it, or deletes the union member. **Phase 1's drift guard fails while a declared policy has no executor**, so this cannot be satisfied by consolidating four of five. The outcome is recorded as an amendment here.

## Consequences

**Positive.** "Declared in the table, enforced somewhere else" becomes unrepresentable. `phase.complete` writing a `stopped_at` that names the previous phase, and a `current_phase` / `current_phase_name` pair describing two different phases, become structurally impossible rather than individually patched. A command's `updated` array becomes trustworthy without a read-back, which is what makes the remaining phases observable from outside.

**Negative / accepted costs.** One new `scripts/` file, shipping in the npm package and installer with its inventory and manifest ripples. Tier-2 output changes will break downstream consumers parsing current command output — deliberately, per ADR-3180 Decision 3, each with its own breaking-change call-out, changeset fragment and docs update. Phase 2 carries a CRITICAL blast radius and cannot be sliced further without breaking the seam in half. The stacked ordering means wall-clock is the sum of four code phases.

**Risks.** The guard cannot see re-derivation through dynamic dispatch; the identity tests are the backstop and only cover the shapes they were written for (`CONTRIBUTING.md` § *Fixture provenance (#2371)*). The closed guard vocabulary of Decision 1 may prove too narrow for a future field — the amendment path is the mitigation, and the alternative (an open predicate slot) is the failure this ADR exists to prevent.

## Alternatives considered

1. **Fix the six instances individually, no contract.** Rejected — that is the status quo whose failure mode #3408 documents, and #3258 is direct evidence: four rows were fixed and the mechanism that let them diverge was not.
2. **Amend ADR-3180 with a write-path section.** Rejected — it is a closed epic whose §7 owners are all read derivations, and `CONTRIBUTING.md` requires one issue = one ADR-or-PRD = one PR.
3. **Design the contract inside Phase 1's PR, skip this ADR.** Rejected for ADR-3180 Alternative 4's reason: Phases 1–4 all depend on it, so it would be set by whatever was convenient in the first code PR, with no reviewable design step.
4. **One mega-PR consolidating all four concerns.** Rejected — a CRITICAL blast radius in a single reviewable unit, `gsd-test` failures unattributable to a concern, and a violation of one-concern-per-PR.
5. **Make frontmatter authoritative over the body.** Rejected — the body-is-truth model is deliberate and `src/state.cts` says so; #3374 is explicit that it is *"not a request to make frontmatter authoritative."*
6. **Keep both enforcement points and add a parity test.** Rejected — ADR-3180 Decision 1: *"A parity test proves the copies agree today; it does not stop copy N+1."*

## Software laws applied

Cross-referenced via `/skills-from-the-artificer`. Three fired; **all three changed this ADR.**

- **Greenspun's Tenth Rule — changed the design.** The table has accreted five times, which is the "nobody decided to build a language — they just kept solving the next problem" trajectory. It is not a rules engine today (five frozen policies, no conditionals/loops/variables, no user extensibility, all consumers in-repo). The open per-row `guard` predicate in this ADR's first draft is what would have made it one. Produced Decision 1's **closed guard vocabulary** and the amendment requirement. Greenspun's prescribed response to an accreting ad-hoc system — "extract, formalize, or replace" — is this ADR.
- **Postel's Law — changed the design.** Produced Decision 2's bright line. ADR-3180's rejection of throwing governs *external* input; an unwired declared row is an internal invariant violation with both ends controlled, which Postel puts on the strict side. Also produced §8.5's divergence warning — "liberal but visible" is the direct answer to #3374's `warnings: []`.
- **Goodhart's Law — changed the design.** "0 write-path bypasses" is a measure becoming a target. Produced Decision 5's enumerated gaming routes and the rule that the guard's zero is **never reported without the identity test's result beside it**.

Considered and not applicable to *this* deliverable: **Hyrum's Law** and **Gall's Law** govern Phases 1–4's Tier-2 output changes and incremental sequencing and are recorded in Decisions 3, 5 and 6, but Phase 0 ships no behavior. `choose-boring-technology` — no new dependency; five in-repo guard precedents. `conways-law` — no ownership boundary at stake.

## Cross-references

- [ADR-3180](3180-planning-semantic-model-single-owner.md) — the read-side precedent this mirrors; its Decision 4 (a)–(e) is adopted verbatim
- [ADR-2121](2121-phase-identifier-parsing-consolidation.md) — the proven guard mechanism both ADRs extend
- `scripts/lint-state-field-drift.cjs` — the guard pattern Decision 5 models
- `scripts/qa-smell-ratchet.cjs` — the ratchet invariants Decision 5 adopts
- `scripts/lib/drift-scan.cjs` — the shared tree-walk / confinement / sanitizer every guard uses
- `CONTRIBUTING.md` § *Prohibited: Raw Text Matching on Test Outputs* — why reports are typed IR, not prose
- `CONTRIBUTING.md` § *Fixture provenance (#2371)* — why the identity test alone is insufficient
- Phase sub-issues: [#3467](https://github.com/open-gsd/gsd-core/issues/3467), [#3468](https://github.com/open-gsd/gsd-core/issues/3468), [#3469](https://github.com/open-gsd/gsd-core/issues/3469), [#3470](https://github.com/open-gsd/gsd-core/issues/3470), [#3471](https://github.com/open-gsd/gsd-core/issues/3471)

### Guard roster

One row per concern. A blank owner is a concern whose contract is locked (§8) but whose owner does not exist yet.

| Concern | Owner | Guard | Scan surface | Status |
|---|---|---|---|---|
| Policy dispatch (§8.1) | `state-transition.cts` (Phase 1) | `lint-state-write-path-drift.cjs` | `src/` | contract only |
| Unenforced row (§8.2) | `state-transition.cts` (Phase 1) | same guard | `src/` | contract only |
| Write seam (§8.3) | `state.cts` (Phase 2) | same guard | `src/`, `gsd-core/workflows`, `commands`, `agents`, `skills` | contract only — ratcheted from Phase 1 |
| The report (§8.4) | `state-transition.cts` (Phase 3) | Phase 3 | `src/` | contract only |
| Stale-but-present (§8.5) | `state.cts` (Phase 4) | same guard, baseline 0 | `src/` | contract only |

## Amendments

### Amendment 1 — Phase 1 (#3468) validation: the contract held; a policy had two implementations

Decisions 1–5 needed **no change**. Every input class Phase 1 hit was expressible in the contract as written, and the closed guard vocabulary of Decision 1 proved sufficient at exactly the size predicted. What the contract did *not* anticipate was a divergence one level below the policy.

**`preserve-always` had two divergent implementations, and one contradicted its own row.** Neither #3408 nor this ADR named it; it fell out of reading the code rather than the write-up.

| Field | Declared | Implemented as | Gate |
|---|---|---|---|
| `progress` | `preserve-always` | preserve-always | `!resync`, no delta condition |
| `current_phase_name` | `preserve-always` | **preserve-when-unchanged** | body `Phase:` delta, no resync gate |

**Resolution: the row was wrong, the code was right.** `current_phase_name` is reclassified to `preserve-when-unchanged`. Its delta-gated behavior is regression-bound by #1743, #1695 and #2736, so changing the code to match the label would have broken deliberate decisions; changing the label is behavior-preserving and makes the table honest, which is the point of the epic. Matrix test C2 pins its exact outputs as literals, because a behavior-preserving change is precisely where a silent mistake hides.

**§8.6 resolved: `clear` is DELETED.** No row used it and no executor existed — verified as the single occurrence of the token in `src/state-transition.cts`, with zero dependents and a clean `tsc`. Speculative Generality: a policy invented for a need that never arrived. `FieldPreservation` now has four members, each with exactly one executor.

**The closed guard vocabulary is real and small.** Decision 1 mandated named guards over a predicate slot. Implementation found exactly **one** true executor-side guard in the entire codebase — `status`'s `'unknown'` sentinel — because `stopped_at`'s `## Session` scoping turned out to be caller-side *extraction*, not an executor condition. Shipped as `FieldGuard = 'non-sentinel-unknown'` plus `FieldMergeStrategy = 'progress-ratchet'` for the #2440/#2969 merge. Two single-member unions is deliberate: the alternative is the open predicate slot Greenspun's Tenth Rule rejects, and adding a member remains an amendment here.

**Copy count, per Amendment 3's standing rule — "N found by the guard", never "N per the epic":**

| | #3408 scoped | Guard found |
|---|---|---|
| Write-seam bypasses (Axis 2) | 2 | **4** |
| Policy-dispatch violations (Axis 1) | not scoped | **7** — 5 field-name branches, plus `derive` and `clear` with no executor at all |

The four are `cmdStateSync`, `cmdMilestoneComplete`, `cmdPhaseComplete`, and `REGENERATE_STATE`. **`patchCore` — one of the two this ADR named — is not among them**, because it bypasses via `stateReplaceField` rather than the seam calls. The epic's list was both short and partly wrong, a fourth consecutive confirmation that a hand-maintained list is a lower bound.

**Two detectors were built and removed again, recorded because the guard is the instrument this epic trusts:**

1. A prompt-layer detector reported **5 backticked prose mentions** as drift — ADR-3180 Amendment 3's recorded false-positive class. `CONTRIBUTING.md` already settles it: a backticked command reference is a mention. Now gated on inline-code spans.
2. A `stateReplaceField` co-occurrence detector for §8.3(b), measured at **29 false positives to 1 true positive** — it matched the function's own *definition* and ~20 calls on frontmatter-free body slices. Banking 29 non-defects to catch one is Decision 5's own "ratchet as a parking lot" route, so shipping it would have made the guard violate this ADR.

**DECLARED KNOWN GAP, owned by Phase 2 (#3469).** §8.3(b) — `patchCore` writing over frontmatter — is **not detected**. It needs genuine dataflow ("is this argument the whole document or a body slice?"), not co-occurrence. Phase 2 both fixes the defect and makes detection tractable, because once the pure pipeline exists the invariant simplifies to "no transition core calls `stateReplaceField` on unstripped content". Stated here so the gap has a named owner rather than being a silence.

**Decision 5's anti-gaming list earned itself twice, in one phase.** After the refactor the guard reported `policyDispatchViolations: 0` while `applyPreserveIfPlaceholder` still opened with `if (field !== 'milestone_name') return` — a branch selected by field name, which §8.1 forbids outright, in a syntactic form Axis 1 did not match. That is the "route it through a differently-named local" row of Decision 5's table, live. The executor was already idempotent, so the test bought nothing and was deleted; Axis 1 is widened to catch field-variable comparisons against literals, with its remaining evasion (renaming the loop variable) declared in the guard's header rather than left implicit. Separately, the guard's own `loadBaseline` conflated an *unreadable* baseline with an *absent* one — a diagnostic collapsing two states into one identical result, which is this epic's defining failure shape reproduced inside the tool built to detect it. Both fixed in Phase 1.

**Complexity, measured before and after.** `applyStatePreservation` was 177 lines, cyclomatic 61, cognitive 107, `risk_level: critical`. It is now a 27-line dispatch loop over four executors of 28, 44, 26 and 3 lines. This was Kernighan's Law's contribution to the design — the justification for the refactor was debuggability, not line count, and the largest remaining unit is the one holding the genuinely intricate #2440/#2969 ratchet.

### Amendment 2 — Phase 2 (#3469): §8.3 was over-broad, and the ratchet's target was wrong

Decisions 1–5 held. §8.3's **rule** did not.

**"Every STATE.md write applies the pipeline" is false by design.** `state sync` and `REGENERATE_STATE` exist to let the body win; preservation exists to stop the body winning. §8.3 now carries the closed exception list above, and both are permanent `owner: sanctioned-permanent` ratchet entries.

This was not a theoretical over-reach. #3469's own scope line, inherited from the epic, said to route the direct `writeStateMd` callers through the pipeline — which for `cmdStateSync` would have inverted the command, silently, with every gate green. The correction came from reading `applyPostSyncPreservation`'s docstring and then **verifying the claim against the code**, because a stale comment had already misdirected this epic once (`CONTEXT.md` pointed at a `verify.cts:1925` call that had moved to `health-diagnostic.cts`).

**Consequence: Decision 5's and Phase 4's "ratchet to 0" target is wrong.** This ADR's guard roster and #3471 both say Phase 4 drives the baseline to empty and deletes the file. It cannot — two entries are permanent. **The correct end state is 2 permanent entries, not 0**, and the honest report is *"0 removable bypasses, 2 sanctioned"*. A guard that could reach 0 here would only do so by having stopped looking at two real writers.

**What Phase 2 actually found in the tree**, after `fix(#3374)` (#3491) landed part of §8.3 upstream mid-epic:

1. **`cmdPhaseComplete` re-assembles the pipeline.** Upstream routed it through `applyPostSyncPreservation`, but it still calls `syncStateFrontmatter` directly first. Every step calls an owner, so Axis 2 and an owner-level test both stay green while the *composition* is duplicated between the adapter and `readModifyWriteStateMd`, free to diverge. This is ADR-3180 Amendment 2's composition-level re-derivation, repeating on the write side, and §8.3 already forbade it by name.
2. **`cmdMilestoneComplete` is the remaining real exposure** — it writes through `writeStateMd`, so it gets sync and no preservation, the identical shape #3374 reported for `phase.complete`. Upstream flagged it as a follow-up in the same docstring; Phase 2 is that follow-up.
3. **Phase 1's declared known gap closes here**, as promised rather than re-deferred: §8.3(b)'s frontmatter-write detection becomes tractable once the composition exists, because the invariant simplifies to "no transition core calls `stateReplaceField` on unstripped content".

**Criterion 6 context.** All five of the epic's named instances were closed by point fixes while Phase 1 was in flight, so Phase 2 and Phase 4 are driven by **characterization tests at the consumer's output** (Decision 4(b)/(c)) rather than fail-first tests. Weaker, and stated as such.

### Amendment 3 — Phase 4 (#3471): there was a FOURTH enforcement point, and the guards could not be deleted

The contract held. Two of this section's own statements did not.

**§8.5 said the guards are "deleted". They cannot be.** `writeStateMd` — the sole path for both §8.3 sanctioned-permanent exceptions — never runs `applyStatePreservation`, so those six conditions were their **only** empty-field fallback. A baseline probe on the unedited tree confirmed unconditional deletion drops `current_phase`, `current_phase_name`, `current_plan`, `stopped_at` and `paused_at` from a blank-body STATE.md on `state sync`, breaking the byte-identical guarantee §8.3 grants it. They are **gated**: on for the exceptions, off for the write seam. §8.5 is corrected above.

**§8.5 mis-located `cmdStateJson`'s guards.** It described them as living "in `syncStateFrontmatter`". They were a **separate private copy** on the read path, with no delta check at all — so a stale body annotation always beat fresher curated frontmatter in `state.json`, reproducing #3395's shape entirely outside the write seam. Now routed through `applyPreserveWhenUnchanged`. `shouldPreserveExistingProgress`'s cross-milestone logic is a different rule and is untouched.

**THE FINDING: a fourth enforcement point nobody had counted.** The pre-existing #2202 unknown-key carry-forward loop independently restored the same six fields whenever `derivedFm` lacked the key — silently neutralizing the gating fix. It is named nowhere in this ADR, in Phase 4's design, or in three prior phases. It was found only because a probe that should have passed did not: the first attempt reported `divergedFields: []` and restored the stale values, reproducing the exact bug the phase existed to close.

That is the **fourth consecutive time** a copy count in this epic proved a lower bound — 2 write-seam bypasses became 4, three preservation encodings became four, and the estimate was wrong every single time. ADR-3180 Amendment 3's standing rule has now earned itself in every phase of this epic: **read the code, not the write-up.**

**`divergedFields` could not see a discard.** It diffed `postFm` before and after preservation, so it could only observe fields actively *restored*. A discard-to-empty is absent on both sides and was therefore invisible. A second pass reports it, which is what makes the new "a discard is as visible as a restore" rule real rather than aspirational.

**Decided — Row 2, the delete-the-body-line case.** When a transform deliberately removes a body line, the derived (empty) value wins per the delta rule and the curated value is dropped. Consistent with "same terms as empty", and it discards a value that previously survived on that path — so it is reported rather than silent. This is the sharpest Hyrum exposure in the epic and ships with its own call-out.

**§8.4's residue, folded in when Phase 3 (#3470) closed as subsumed.** `fix(#3351)` reconciled only `cmdStatePatch`. Seven commands now share **one** `reconcileReportedFields` helper — not five copies of that block, which would have been this epic's own defect class introduced in its final phase. Both previously-untraced commands were traced rather than assumed: `cmdStatePlannedPhase` matched `cmdStateBeginPhase` exactly; `cmdStateCompletePhase` turned out to be a different legacy path reporting field names **and** a section name, where the naive helper would have dropped `Current Position` as a false negative every time.

**A parity assertion, because the fix needed one.** `FRONTMATTER_KEY_TO_BODY_LABEL` is a second table beside `FIELD_CLASSIFICATION`, and a missing entry originally fell back silently to the raw key. That is this epic's shape in miniature. A missing `preserve-when-unchanged` label now throws with a structured error mirroring §8.2's `throwUnwiredRow`, and a test asserts every such row has an entry — the parity assertion `CLAUDE.md`'s *Generative Fix Divergence* entry requires whenever two surfaces share a constant. The throw is deliberately scoped to that policy: `divergedFields` legitimately carries `progress`, `milestone` and `milestone_name`, which have no body-line label, and an unconditional throw would have broken a live case.

*(Phase 3's §8.4 bucket decision was folded here; `fix(#3351)` (#3487) subsumed most of Phase 3, which closed as subsumed.)*

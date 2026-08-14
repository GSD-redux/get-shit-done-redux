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

This is what makes "one write seam" achievable without breaking anything. `cmdPhaseComplete` bypasses the seam today for a **legitimate** reason its own comment gives (`src/phase.cts:2940-2944`):

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
| Exempt the owner file | 4(d) — owner **functions** are exempt; the owner **file** is not. `state.cts` is both the owner and the largest bypass surface, and ADR-3180 Amendment 4 records this exact exemption failing |
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

## 8. The behavior contract — THIS SECTION IS THE SOURCE OF TRUTH

Decisions 1–7 answer *how* the write path is organized. This section says *what the right answer is*, and it is what the guards and identity tests of Decision 5 test **against**.

- **Where this section and the code disagree, the code is the defect** — not this section, and not a caller's local expectation.
- A behavior not stated here is **not decided**. It is recorded as an open question with a forcing function, never resolved silently inside an implementation PR.
- Amending a rule here is an amendment to this ADR, not a code change with a comment.
- Each rule carries a **status**: *Enforced* or *Required — Phase N*. A *Required* rule is as binding as an *Enforced* one; the only difference is whether the tree satisfies it yet.

### 8.1 Policy dispatch — *Required — Phase 1*

**Question.** Given a STATE.md field and its `FIELD_CLASSIFICATION` row, what decides its value after a write?

**Owner.** `src/state-transition.cts` · `applyStatePreservation`, dispatching on `row.preservation`.

**Rule.** Exactly one executor exists per `FieldPreservation` member. No branch is selected by field name. Field-specific conditions are named guards from a closed vocabulary; a new guard kind is an amendment to this ADR.

**Failure signal.** §8.2.

### 8.2 An unenforced row — *Required — Phase 1*

**Rule.** A declared `preserve-when-unchanged` row reaching the executor with no wired body-source delta **throws**. This applies to internal invariant violations only. A user document that is drifted, malformed, or unparseable **never** throws — §8.5 governs it.

**Rule.** Where both conditions hold at once, the invariant violation is reported first: it is a defect in our source, and reasoning about the user's document under a broken policy table is meaningless.

### 8.3 The write seam — *Required — Phase 2*

**Question.** What is allowed to write STATE.md?

**Owner.** `src/state.cts` · the pure sync + preservation pipeline, and `readModifyWriteStateMd` as its I/O wrapper.

**Rule.** Every STATE.md write applies the pipeline. A caller needing a different I/O envelope — `cmdPhaseComplete`'s atomic three-file commit via `writePlanningFileSet` — calls the pipeline and supplies its own envelope. It does not re-assemble the stages, and it does not skip them. Assembling the stages at a call site is a re-derivation even when every step calls the owner.

**Rule.** `current_phase` and `current_phase_name` are written as a **pair**. A transaction that computes one from a phase number writes both from that same number, so the two cannot describe different phases (#3350).

**Consumers that must route through the owner.** `readModifyWriteStateMd`'s 16 callers, `cmdPhaseComplete` (`src/phase.cts`), `patchCore` and `updateCore` (`src/state-transition.cts`), plus any direct `writeStateMd` caller — `milestone.cts`, and `verify.cts`'s `regenerateState` factory-reset primitive, which `CONTEXT.md` records as a deliberate direct writer and which is therefore a **named ratchet entry**, never an unrecorded pass.

**Guard.** `scripts/lint-state-write-path-drift.cjs`.

### 8.4 The report — *Required — Phase 3*

**Question.** What does a command's `updated` / `failed` array mean?

**Rule.** It names the fields whose **persisted** value changed, computed from `postFm` after preservation. A field the caller asked for that did not change is not `updated`. Whether "not found" and "found, written, then restored by policy" are distinguishable buckets is **decided in Phase 3 and recorded as an amendment here** — it is a behavior this section does not yet state, so per §8's own rule it is not decided.

### 8.5 Stale-but-present — *Required — Phase 4*

**Question.** The body source disagrees with frontmatter and the derived value is non-empty. Who wins?

**Rule.** The declared policy decides, on the same terms as an empty derived value. `preserve-when-unchanged` restores the curated frontmatter value when that field's body source did not change in **this** write. The empty-only "#905" guards in `syncStateFrontmatter` are **deleted**, not kept in sync — one enforcement point on every path, including `writeStateMd` and `cmdStateJson`.

**Rule.** **Preservation is visible.** When policy restores a curated value over a disagreeing derived one, the command emits a divergence warning. Silence is the defect #3374 reported (`warnings: []`), not the fix.

**Rule.** A drifted body is an ordinary, expected user-document state. It is what this contract preserves against — never an error, never a throw (§8.2).

### 8.6 `clear` — *OPEN QUESTION, forcing function: Phase 1*

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

*(None yet. Phase 1 records its `clear` resolution (§8.6) and its guard's measured baseline here; Phase 3 records the §8.4 bucket decision.)*

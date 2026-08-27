# ADR-3473: Enforcement by Construction — One Owner per Invariant

- **Status:** Accepted. Phase 0 ships this file alone; every rule in §8 is *Required — Phase N* until its phase lands.
- **Date:** 2026-08-25
- **Issue:** [#3473](https://github.com/open-gsd/gsd-core/issues/3473) is the **scope authority** (`epic` + `approved-enhancement` + `area: core`), which is why this ADR carries its number. [#3868](https://github.com/open-gsd/gsd-core/issues/3868) is the Phase-0 tracking sub-issue this PR closes — the epic stays open until the final phase merges. Convention follows [ADR-3180](3180-planning-semantic-model-single-owner.md) and [ADR-3408](3408-state-write-path-preservation.md).
- **Supersedes:** nothing.
- **Relationship to prior work:** the **third** application of ADR-3180's mechanism. [ADR-3180](3180-planning-semantic-model-single-owner.md) gave each read-side derivation one owner; [ADR-3408](3408-state-write-path-preservation.md) applied the same mechanism to the STATE.md write path. Both succeeded on their declared surface. This ADR owns the invariants that sit **outside both** — document parsing, enumeration, and the return contract of every routine that can fail — and adds the step neither took: **retiring the guard once the seam makes it redundant.**

Symbol names are the durable anchors throughout. Line references are as of `next` @ `e40e9670f` and will drift.

## Context

Three mechanisms, one shape — **the invariant is not representable in code, so every consumer re-derives it by hand.**

The evidence base is #3473's filing (a systemic root-cause review of all 30 open `confirmed-bug` issues on 2026-08-14) plus a re-verification against `next` @ `e40e9670f` on 2026-08-25. Where the two disagree, this section carries the later reading and says so.

### A. Policy declared once, enforcement hand-rolled per call site

| Invariant | Canonical owner | Reality on `next` |
|---|---|---|
| slug rule | `generateSlugInternal`, `src/core-utils.cts` | **11** inline copies across **7** files (measured in Phase 6, #3883 — the "13 across 5" written here was wrong twice over: two of the thirteen were an unrelated tokenizer regex, and the file count was never taken); copies and generator disagree on Cyrillic transliteration and trim-vs-truncate order (#2986) |
| `isSentinelPhaseId` | `src/phase-id.cts` | consumed by 11 modules, absent from 4 phase-enumerating commands (#3372) |
| verification-file discovery | *(none)* | independently implemented twice, both alphabetical-first (#3357) |
| runtime identity | `bin/install.js` persists it | `resolveRuntime` never reads it back (#3364) |
| Codex sandbox policy | the managed role contract | installer map lists a subset; absent roles fall back to `read-only`, and `validate agents` passes anyway (#2540) |
| decision phase | `fm.current_phase` | `cmdStateAddDecision` never consults frontmatter, persists a literal `[Phase ?]` (#3231) |
| `depends_on` resolution | `resolveDependencyId`, `src/phase.cts` | the retired SDK lineage carried a third `shortFormToId` tier the surviving lineage never had (#3427) |

### B. A hand-rolled YAML dialect

`parseYamlRegion` (`src/frontmatter.cts`) strips surrounding quote characters but never inverts the `escapeDoubleQuoted` that `reconstructFrontmatter` applies on write. A quoted field's byte length roughly **doubles per read-modify-write cycle** until any command that loads the file OOMs (#3349).

Two `/m`-anchored patterns in the same module use `\s` at a `^` position. Per ECMA-262, `\r` is a LineTerminator in its own right, so under `/m` the `^` asserts *between* the `\r` and the `\n` of a CRLF pair and the `\s` swallows the `\n` — `parseMustHavesBlock` returns `[]` for all four `must_haves` blocks in every CRLF plan file (#3360).

`js-yaml` is already a devDependency and already in the lockfile. Production ships the hand-rolled parser.

### C. Absence, emptiness and failure all encode as success

- `parseNamedArgs` discards unrecognized and positional tokens with no error; the flag resolves `null` and `cmdStatePlannedPhase` runs anyway (#3358).
- `phases.list --pick summaries_total` returns an empty string with **exit 0**, so the `$(… || echo "0")` idiom never fires (#3365).
- `routeQuickTasksAppend` writes a row that contradicts the row `quick.md` specifies (#3356).
- `review.md` writes `REVIEWS.md` even when every reviewer lane fails, then deletes the evidence (#3352).
- `resolveDependencyId` returns `null` for an unresolvable `depends_on` token; every call site treats it as `continue`, every short-form edge is dropped, and the tool then emits a wave-mismatch verdict **manufactured by its own data loss** (#3427).
- `phase.complete`'s Requirements-line tokenizer silently under-selects: a spaced range marks only its two endpoints, a tight range marks nothing, and neither warns (#3697).
- `acknowledgeDeferredItem` returns `ok` having written nothing when a U+2028 sits in a deferred item's status line (recorded on #3473, 2026-08-23 — the same ECMA-262 LineTerminator shape as #3360 with a different terminator).

### D. The STATE.md family — the surface two ADRs left between them

This family is the reason Phases 1–3 exist and is recorded here rather than inferred later.

ADR-3408 shipped completely: all five phases closed, `scripts/lint-state-write-path-drift.cjs` is live, and its write-path drift baseline stood at **two entries, both `owner: sanctioned-permanent`** — zero debt. The seam is real and it held. *(That baseline was retired, file and all, by Phase 1 — see §8.6's amendment. This paragraph records the state at filing.)*

Eleven state defects were nonetheless filed between 2026-08-21 and 2026-08-25 (#3853, #3836, #3835, #3834, #3830, #3818, #3812, #3807, #3784, #3756, #3743). **None is a bypass of that seam.** They sit at four places it does not reach:

| Location | Mechanism | Issues |
|---|---|---|
| the seam's **input** | `applyStatePreservation`'s precondition — a populated pre-write snapshot — is unexpressed. When it is absent every declared row silently no-ops, so a `preserve-always` field is destroyed by verbs unrelated to it | #3756, #3834, #3835, #3836 |
| the seam's **output** | `reconcileReportedFields` excludes `progress` **by classification** to dodge the #1264 regression; the same exclusion suppresses the case where the field genuinely changed | #3743, #3818 |
| the **schema** | the key set, its types, its enums and its cardinality are transcribed by hand into nine artifacts, so no writer can consult a declared enum and no reader can consult a declared cardinality | #3853, #3812 |
| **derivation authority** | which source is authoritative for a fact. Owned by neither ADR — ADR-3408 §7 scopes it out, ADR-3180 covers read derivations only | #3830, #3807, #3784 |

The fourth row is **not in this ADR's scope.** It is [ADR-3180 Amendment 8](3180-planning-semantic-model-single-owner.md), which generalizes §7.5's already-locked sentence — *"Prose is not a lifecycle signal … a caller may not compensate by reading prose locally"* — from plan-lifecycle to every derivation in Decision 7, on read **and** write. Recorded here so a future reader does not file it against this epic a third time.

The first three rows are instances of §8.4 (failure is a value) and §8.3 (one implementation per rule) at a surface specific enough to phase, and they are Phases 1, 2 and 3 respectively.

### The failure mode that hides all of it

This is ADR-3180's signature shape, one layer out: **the failure and the success are output-identical.** Every row above returns a plausible value no caller can distinguish from a real one. #3258 is the proof the trap works as designed — a careful reporter read the `FIELD_CLASSIFICATION` table, correctly identified an unimplemented row, and filed #3234 for a symptom that does not occur, because the policy was enforced ~1300 lines away in a different module.

### Why a contract, and not twenty point fixes

25 of the 30 open `confirmed-bug` issues surveyed in the 2026-08-14 filing cite a prior issue by number, and **10 state explicitly that an earlier fix landed on one branch, one call site or one input shape and left the family alive.** The intake rate is not discovery. It is one issue per unpatched call site.

The response to each family so far has been a **detector**: 22 custom ESLint rules and 43 lint/drift-guard scripts, 18 with `drift` in the filename (counted at `next` @ `e40e9670f`; #3473's filing said 20 / 45 / 12 on 2026-08-14 and the mix has drifted since). A detector encodes the fingerprint of the last bug, not the class. Two demonstrations, both verified:

1. `local/no-crlf-fragile-split` is registered at **error** on `src/**/*.cts`, widened from tests to source by ADR-3212 Phase 2 *specifically to stop CRLF parse bugs*. #3360 is a CRLF parse bug in `src/frontmatter.cts` that shipped under it — the rule fingerprints a bare `\n` in a regex; the defect is `\s` at a `^` under `/m`, which matches `\n` but contains none. **The guard structurally cannot see it, and lint is green.**
2. `local/no-adhoc-markdown-parsing` is registered in exactly one config block, `src/**/*.cts` — not `tests/`, not `scripts/`, not `bin/`. #3426 and #3239 are hand-rolled section and table scans inside `tests/package-legitimacy-gate.test.cjs`, outside its glob. **A gate's own parsing is now a defect that can false-pass.**

## Decision

### 1. Every invariant in §8 has exactly one owner, and the wrong call site is unrepresentable

Not *detectable* — unrepresentable. Where a seam can make a call site impossible to write, that is the fix; a guard is the fallback, not the goal.

### 2. A declared policy with no executor is a LOUD failure — and this line does not extend to user documents

ADR-3408 Decision 2's bright line is adopted verbatim and extended to this ADR's surface:

| Bad input | Response |
|---|---|
| **Internal invariant violation** — a declared row with no wired executor, or a pipeline stage reached without its required input | **throw.** Both ends are gsd-core's own source; it is a programming error unreachable from any user document |
| **User-document defect** — a drifted, malformed, or unparseable `.planning/` file | **never throw.** Degrade per policy and *warn*; behavior otherwise unchanged |

Getting this backwards would turn every desynced project's `phase.complete` into a hard failure. It is a rule, not a note.

### 3. Failure is a value

Every routine that can fail returns the hub's existing `Result = {ok,data} | {ok:false,kind,…}`. `[]`, `""`, `null` and `exit 0` stop being legal ways to say "I could not parse this."

### 4. Where a routine discards an input, it says so, naming the input

A derived conclusion may not be reported as authoritative when the derivation dropped input it could not resolve. An unresolved `depends_on` token surfaces its own warning rather than hiding behind a wave-mismatch verdict (#3427).

### 5. The anti-divergence contract

ADR-3180 Decision 4 (a)–(e) is adopted verbatim and not restated. Two constraints are made explicit here rather than inherited, because both have already failed once in this repo:

- **The scan surface is declared and includes the prompt layer** (`gsd-core/workflows`, `commands`, `agents`, `skills`), which can shell out to a query and post-process. A guard registered only on `src/**/*.cts` is how #3426 and #3239 shipped.
- **Owner *functions* are exempt; the owner *file* is not.** ADR-3180 Amendment 4 records a whole-file owner exemption failing in `roadmap-parser.cts`.

Per ADR-3180 Amendment 3's standing rule, each phase states its copy count as **"N found by the guard", never "N per the epic."**

### 6. Guards are retired, not accumulated — with a truthful ledger

Each landed phase names the guard it makes redundant and **deletes it in the same PR**. This is the first epic in this repo whose success metric includes a **shrinking** guard surface.

**The ledger is per-phase-set and honest, not per-PR and gamed.** A phase that legitimately *grows* a guard records the growth in the same ledger rather than omitting it. A net fall that is achieved by not counting an increase is the "measure became the target" outcome Decision 5 exists to prevent.

### 7. Migration order

**Locked for the assigned phases:** Phase 0 (this ADR) → Phase 1 (§8.6) → Phase 2 (§8.7) → Phase 3 (§8.8).

Phases 1–3 are **stacked and sequential**: Phase 2 diffs the snapshot Phase 1 makes mandatory, and Phase 3 generates a table whose executor Phase 1 changes.

`get_impact(applyStatePreservation, direction=upstream, depth=5)` against `next` @ `e40e9670f` rates **LOW** (2 affected symbols, routers only), so Phases 1–3 do **not** inherit ADR-3408 §6's blanket "never parallel" constraint — that constraint was scoped to `readModifyWriteStateMd` (185) and `syncStateFrontmatter` (154), both **CRITICAL**. ADR-3180 Amendment 8 (`advancePlanCore`, **MEDIUM**, 16 affected) is therefore free to run as a concurrent lane; its direct radius and Phase 1's are disjoint, meeting only at the command routers.

**Unassigned.** §8.1–§8.5 carry no phase number yet. They are as binding as the assigned rules; only the tree's conformance differs.

### 8. The behavior contract — THIS SECTION IS THE SOURCE OF TRUTH

Decisions 1–7 answer *how* this epic is organized. This section says *what the right answer is*, and it is what the guards and identity tests of Decision 5 test **against**.

- **Where this section and the code disagree, the code is the defect** — not this section, and not a caller's local expectation.
- A behavior not stated here is **not decided**. It is recorded as an open question with a forcing function, never resolved silently inside an implementation PR.
- Amending a rule here is an amendment to this ADR, not a code change with a comment.
- Each rule carries a **status**: *Enforced* or *Required — Phase N*.

#### 8.1 One YAML parser — *Required — Phase 4*

**Question.** What parses and serializes `.planning/` frontmatter?

**Owner.** A single vendored parser. `parseYamlRegion` and `escapeDoubleQuoted` are **deleted, not patched**. (Post-#3881-review, finding 2: the hand-rolled implementations behind both names are gone — `src/frontmatter.cts` now renames them to `parseGuardedYamlRegion` and `escapeDoubleQuotedScalar` so no function still answers to the deleted scanner's name; see those functions' docblocks for the full reasoning, including why `escapeDoubleQuotedScalar`'s rename required updating its three call sites rather than being treated as an ADR-amendment matter.)

**Rule.** Escaping, quoting, CRLF handling and indentation leave this repo's maintenance surface. Round-trip *values* are identical; a property-based `fast-check` round-trip test is the gate.

**Rule — packaging.** `gsd-core/bin/**` is copied by the installer into runtime dirs that have **no `node_modules`**, so it must contain zero external requires. The dependency is **vendored** to `gsd-core/bin/lib/vendor/js-yaml.cjs` and imported relatively; `js-yaml` stays in `devDependencies`; `scripts/lint-vendored-deps.cjs` byte-compares it against `node_modules` in `lint:ci`. `local/no-external-require-in-bin` (from #3496) fails the build if this is done the naive way. **Promoting `js-yaml` to `dependencies` breaks every installed tree** — this was learned the expensive way in #3496 (100 test failures across 8 install-surface suites) and is recorded as a rule so it is not re-derived.

**OPEN QUESTION — the type contract. Forcing function: this question is answered in §8.1 before any implementation PR for this rule is opened.**

`extractFrontmatter` is deliberately lossy and a large amount of machinery exists to compensate:

- **Every scalar parses as a string.** `gap_closure: true` becomes `"true"`, and `FRONTMATTER_SCHEMAS['plan-gap-closure'].requiredValues` is written as `{ gap_closure: 'true' }` with a comment saying so. A faithful parser returns a boolean and that check silently stops matching.
- **Object-lists are deliberately flattened** to scalar strings. `sliceTopLevelFrontmatterSegments` (#1572), `regenerateFrontmatterKey`'s fail-closed `[object Object]` guard, `frontmatterDeepEqual`, and `noOpObjectListSetError` (#1660) all exist *because* of that flattening.
- **A comment channel** (#3257) attaches column-0 `#` comments to the following key. A faithful parser discards comments.

So this is a **type-contract migration across ~50 call sites**, not a parser substitution. Two answers are admissible:

**(a)** keep a string-coercing adapter over the parser so the existing contract holds, fixing only the escaping and CRLF defects; or
**(b)** migrate consumers to real types and retire the compensating machinery with them.

Both close #3349 and #3360, which are **read-side** defects a real parser fixes regardless of the value types it hands back. (b) is the larger prize and is its own epic-sized change.

**Sequencing note, decided 2026-08-25.** This rule lands **after** Phases 1–3. §8.8's schema declares each key's real type, cardinality and enum — which is precisely the artifact that makes (b) tractable rather than epic-sized. Answering the fork before the schema exists means guessing the type contract; answering it after means reading it off the schema.

> **ANSWER, 2026-08-26 (Phase 4, #3881) — the fork is (a), a string-coercing adapter.** The forcing
> function above is discharged here: the question is answered before the implementation PR opens.
>
> The sequencing note's bet did not pay. Measured against the merged schema rather than predicted:
> `extractFrontmatter` has **78 non-test call sites across 23 files**, and only **33 of them (42%)**
> read STATE.md. The other 45 read PLAN, VERIFICATION, SUMMARY, UAT, roadmap or generic agent/skill
> frontmatter — document kinds §8.8's schema does not model. `FRONTMATTER_SCHEMAS` still declares
> four kinds with **no type declaration for any of them**, and `STATE_FIELD_SCHEMA` has no
> cross-reference to it. (b) would therefore still require net-new type contracts for four-plus
> document kinds: the schema shrank the STATE.md slice of an otherwise unchanged epic-sized
> migration.
>
> The prize is also smaller than the list above implies. Of the five compensating mechanisms named,
> **two survive real types**: `frontmatterDeepEqual` (17 lines, 3 callers) is required for
> no-op/dirty-key detection whatever the value types are, and the #3257 comment channel is orthogonal
> to typing — a faithful parser discards comments, so that channel is needed *more* under (b), not
> less. Only `sliceTopLevelFrontmatterSegments`, the `[object Object]` guard and
> `noOpObjectListSetError` die: **~31 lines across 3 call sites.**
>
> (b) remains the larger prize and is **not** silently dropped — it is recorded here with the numbers
> that say why it stays epic-sized, so a future reader inherits the measurement rather than the
> intuition.
>
> Implementation note: fork (a) needs **no hand-written coercion layer** for scalars. js-yaml's
> `FAILSAFE_SCHEMA` resolves only `!!str`/`!!seq`/`!!map`, so every scalar returns a string by spec.
> `gap_closure: true` stays `"true"` and `FRONTMATTER_SCHEMAS['plan-gap-closure'].requiredValues`
> keeps matching with no call site changed. Verified across `true`, `null`, `~`, `1.5`, `0x10`, a
> date, `yes`, `on`, `.inf`, `NaN` and quoted-vs-unquoted numbers: all agree with legacy.

> **CORRECTION to the answer above, 2026-08-26 (Phase 4, #3881) — fork (a) as this ADR specifies it
> is NOT IMPLEMENTABLE, and the fork itself is ill-posed.** An adversarial pass on the Phase 4 design
> established this by execution, and it supersedes the "(a)" answer recorded above.
>
> (a) is defined as *"keep a string-coercing adapter over the parser so the existing contract holds."*
> That presumes the existing contract is expressible as a function of a parsed YAML tree. **It is
> not.** `extractFrontmatter` is not a YAML parser; it is a **line-oriented scanner whose output is a
> function of the raw source text.** Four spellings of the same value:
>
> | source line | legacy | js-yaml |
> |---|---|---|
> | `  - test: "a b"` | `["test: \"a b"]` | `[{"test":"a b"}]` |
> | `  - test: a b` | `["test: a b"]` | `[{"test":"a b"}]` |
> | `  - test: 'a b'` | `["test: 'a b"]` | `[{"test":"a b"}]` |
> | `  - {test: a b}` | `["{test: a b}"]` | `[{"test":"a b"}]` |
>
> One tree, four legacy strings — one of them mangled, with the closing quote stripped. **No adapter
> over a tree can choose among four outputs that the tree does not distinguish.** Reproducing them
> requires keeping the legacy line scanner, which is the surface §8.1 exists to delete.
>
> The consequence for the fork: **for any document with a non-scalar value, (a) collapses into (b).**
> Structured values cannot be flattened back to their source spelling, so consumers must either accept
> a canonicalized string or move to real types. There is no third option, and roughly 26% of
> frontmatter-carrying documents (230 of 897 by the adversarial count; 239 of 901 by mine — the
> denominators differ by fence-detection edge cases and are reconciled during implementation) hold at
> least one non-scalar top-level value.
>
> **Three further defects in the design this correction replaces**, all confirmed by execution:
>
> 1. **Returning `{}` on a parse failure is destructive, not benign.** Eight call sites across
>    `state-transition.cjs` and `state.cjs` compute `hasFrontmatter =
>    Object.keys(extractFrontmatter(...)).length > 0` and, when false, reassemble the document
>    **without a frontmatter block**. A STATE.md carrying a git merge-conflict marker, a tab indent or
>    a duplicate key parses today and would, under a catch-and-return-`{}` adapter, have its
>    frontmatter **deleted on the next write**. The caller conflates "empty" with "unparseable"; the
>    adapter must not feed that conflation. (Not a live bug today: the only four tracked documents
>    legacy parses to empty are archived changesets, which never reach the state write path.)
> 2. **An empty value silently drops its key.** Legacy parses `progress:` to `{}`; js-yaml yields
>    `null`; `reconstructFrontmatter` **omits any null-valued key**. `gsd-core/templates/state.md`
>    ships an empty `progress:`, so passing null through deletes it on the next write.
> 3. **The truncation probe is not a pre-parse heuristic — it IS `parseYamlRegion`.** #1882's
>    diagnostic cannot both "stay unchanged" and survive that function's deletion. Pointing it at
>    js-yaml silences it on the dominant real shape (fence opened, body follows: legacy sees 2 keys
>    and fires; js-yaml raises `bad indentation` and yields 0 keys, so it stays silent). Keeping it
>    hand-rolled recreates precisely the parallel-surface divergence `frontmatter.cts`'s own comment
>    warns against.
>
> **A new attack surface the fork never considered.** `FAILSAFE_SCHEMA` still resolves anchors and
> aliases. A 7-line frontmatter block expands to a **22.8 MB** structure in 0 ms, and one further
> nesting level is ~200 MB — which `frontmatterDeepEqual` and `reconstructFrontmatter` then walk.
> The legacy scanner is immune, because `&a [...]` is just a string to it. `.planning/` documents are
> **user documents**, so this is a real regression vector that any implementation must close, not a
> theoretical one. Current corpus occurrences of anchors, aliases and merge keys: **zero**, so nothing
> is lost by refusing them outright.
>
> **Verified clean, and worth recording as negatives:** top-level key **order** agrees across all
> frontmatter-carrying tracked documents (0 disagreements); the never-throw claim holds (legacy threw
> on 0 of 11 hostile inputs, including a 200 KB scalar, 20k keys and 5k nested opens); and the ten
> scalar spellings above all agree.
>
> **RESOLUTION, 2026-08-26 (maintainer decision).** Presented with three options — split §8.1 into
> its own epic, take the full semantic migration now, or patch the scanner and drop the vendoring —
> the maintainer chose **the full semantic migration**. Phase 4 therefore adopts js-yaml's semantics
> as truth and carries all seven consequences above, rather than attempting the contract-preservation
> that §0.1 proves impossible. The fork is not answered as (a) or as (b); it is answered as **"the
> fork was ill-posed, and the migration is semantic."**
>
> **Guard ledger, counted rather than estimated — Phase 4 GROWS.** Excluding the 3,014 vendored
> third-party lines, the hand-maintained surface is **+307 lines** net: `src/frontmatter.cts` alone is
> +248/−180 = **+68**, growing *despite* deleting four functions, because the compatibility layer that
> reproduces this repo's bespoke contract on top of js-yaml is larger than the scanner it replaced.
>
> So §8.1's stated benefit — *"escaping, quoting, CRLF handling and indentation leave this repo's
> maintenance surface"* — **is not delivered as written.** Those concerns did leave; a compatibility
> layer replaced them and the line count rose. What genuinely improved is the *kind* of code
> maintained: this repo no longer owns YAML spec conformance, whose bugs were #1779, #1882, #1572,
> #1660, #3257 and #3497. It owns a thin adapter over a parser whose correctness is upstream's
> problem. That is a real gain, and a smaller one than the rule claimed.
>
> Decision 6 requires the growth be recorded rather than netted away — a net fall achieved by not
> counting an increase is the Goodhart outcome Decision 5 exists to prevent. Across the epic: Phase 1
> shrank (−665 lines, −1 file); Phase 2 was flat; Phase 3 grew (+2 guard surfaces); Phase 4 grows
> (+307 lines). **Only one of four phases delivered the shrink this epic was framed around.**

> **Amendment, 2026-08-26 (Phase 4, #3881) — the justifying sentence above is wrong, and this is the
> THIRD wrong premise in this ADR.** The claim *"Both close #3349 and #3360, which are read-side
> defects a real parser fixes regardless of the value types it hands back"* describes defects that no
> longer exist. Verified by **executing** the compiled parser at `ddde001af`, not by reading it:
>
> - **#3349** (escape never inverted on read → `b → 2b+1` growth per read-modify-write until OOM): four
>   successive round-trips of a value containing `"` and `\` return it **byte-identical every time**,
>   length stable. `unescapeDoubleQuoted` is a genuine inverse, shipped under **#3497**.
> - **#3360** (`\s` at `^` under `/m` eating the `\n` of a CRLF pair → `[]` for every CRLF `must_haves`
>   block): LF and CRLF inputs both return `["alpha","beta"]`.
>
> Both issues are CLOSED. After §8.6's "keeps only its raw-write check" (no such check existed) and
> §8.8's "delete `lint-state-field-drift.cjs`" (it guards an unrelated contract), the pattern is now
> established firmly enough to be stated as a rule: **a factual claim in this ADR is a hypothesis
> until the implementing phase executes it.** Decision 6 obliges a phase to verify a claim before
> acting on it, not merely to count the result.
>
> **The Rule survives the collapse; only the justification died.** *"Escaping, quoting, CRLF handling
> and indentation leave this repo's maintenance surface"* is untouched, and the evidence for it is
> better than the two dead issues ever were: #1779, #1882, #1572, #1660, #3257 and #3497 are all this
> repo paying, repeatedly, to maintain a YAML parser.
>
> **And the phase found live defects the dead ones did not cover.** A differential across all 901
> frontmatter-bearing tracked documents shows **99.1% exact key-set agreement** and 2,177 of 2,178
> scalars byte-identical — with **every disagreement being the legacy parser wrong**:
> - **Block scalars are not parsed at all.** `commands/gsd/add-tests.md` declares
>   `argument-instructions: |`; the legacy parser returns the block indicator `"|"` as the value,
>   discards the instruction text, and invents a **phantom top-level key `Example`** from inside the
>   block body. A live defect in a shipped artifact.
> - **A Unicode key is silently dropped.**
>
> §8.1 closes both by construction. That is the payoff this rule actually has, and it is recorded
> from measurement rather than inherited from a sentence.

#### 8.2 Enumerations return correct values by construction — *Required — phase unassigned*

**Question.** What does an enumeration of phases, plans or artifacts return?

**Rule.** `listPhaseDirs()` and every phase/artifact enumerator returns sentinel-filtered ids. A caller that wants sentinels asks for them explicitly. **An unfiltered enumeration does not exist to be forgotten.**

**Rule.** Verification-file discovery has one resolver, **canonical-filename-first, never alphabetical** (#3357).

#### 8.3 One implementation per rule — *Required — Phase 6*

**Rule.** Every slug call site delegates to `core-utils`. `resolveRuntime` reads the install marker in one place with one cache. The Codex sandbox derives from the role's declared tool contract rather than a maintained subset map, and `validate agents` fails on semantic drift, not just on missing files.

> **Correction, 2026-08-26 (Phase 6, #3883) — I wrote this section as if it described decisions already taken. Measured against `next` @ `832dcbb75`, it describes unbuilt work, and three of its statements are wrong.** These are my errors, not inherited ones: I authored this ADR in Phase 0 (#3868/#3870) and stated these as rules without executing against the tree.
>
> | As written | Measured |
> |---|---|
> | "13 inline copies across 5 modules" | **11 copies across 7 files** (`commands.cts` ×1, `init.cts` ×4, `phase-id.cts` ×2, `phase-locator.cts` ×1, `workstream-name-policy.cts` ×1, `active-workstream-store.cts` ×1, `gsd2-import.cts` ×1). Two of the thirteen I counted were an unrelated tokenizer regex. The file count in my first correction (2026-08-26, same day) was itself wrong — I corrected 13→11 without recounting files and repeated the same class of error I was correcting. The divergence itself is real and reproduced: on Cyrillic input the canonical `generateSlugInternal` (`src/core-utils.cts:107`) yields `privet-mir` while `cmdGenerateSlug` (`src/commands.cts:200`) yields `""`; at the truncation boundary the copy leaves a trailing hyphen (#2849's regression, still live in the copy). |
> | "`resolveRuntime` reads the install marker in one place with one cache" | **It reads no marker at all.** `src/runtime-slash.cts:132` resolves `GSD_RUNTIME > config.runtime > 'claude'`, with no marker read and no cache. PR **#3382**, which I cited as prior art implementing this rung, is **CLOSED and unmerged**. |
> | "The Codex sandbox derives from the role's declared tool contract… and `validate agents` fails on semantic drift" | **Both halves false.** `generateCodexAgentToml` (`bin/install.js`) still reads `CODEX_AGENT_SANDBOX[agentName] \|\| 'read-only'` — a hand-maintained subset map with a silent fallback. `checkAgentsInstalled` (`src/agent-install-check.cts:156`) checks file presence and manifest completeness only; it has no `sandbox_mode` or tool-contract assertion. |
>
> The `shortFormToId` rule below is **accurate** — no such tier exists on `next`, and `resolveDependencyId` (`src/phase.cts:609`) remains two-tier.
>
> **The guard roster names no §8.3 casualty.** Its only §8.3-tagged row is `local/no-adhoc-regex-escape`, marked *widened*, not retired. Nothing is retired by this rule.
>
> **What this means for the phase:** unlike §8.2, this section is genuinely unbuilt — the rewrites it asserts have not happened. It is a work list, not a conformance check, and it should be read that way.
>
> **ANSWER, 2026-08-27 (#3897, carrying Phase 6's remaining rungs) — rungs 2–4 built; re-measured, not inherited.**
>
> | As corrected above | Now measured |
> |---|---|
> | "`resolveRuntime` reads no marker at all… PR #3382 … CLOSED and unmerged" | **Fixed.** `resolveRuntime` (`src/runtime-slash.cts`) now resolves `GSD_RUNTIME > config.runtime > install marker > 'claude'`. The four hand-rolled `readInstallRuntimeMarker` copies (`model-resolver.cts` + two in `gsd-cursor-subagent-start.js` + one in `gsd-agent-isolation-guard.js`) are consolidated into one module-level-cached reader owned by `runtime-slash.cts`; the marker's raw contents are routed through the same `resolveRuntimeNameFromCandidates` normalization the env rung uses, never trusted verbatim. Mined from #3382 per this ADR's own direction, not re-derived. |
> | "`generateCodexAgentToml` still reads `CODEX_AGENT_SANDBOX[agentName] \|\| 'read-only'`… `checkAgentsInstalled` has no `sandbox_mode` assertion" | **Fixed, with a qualification.** `CODEX_AGENT_SANDBOX` (11 entries) and the silent `\|\| 'read-only'` fallback are deleted; `sandbox_mode` now derives from each role's declared `tools:` frontmatter (`Write`/`Edit` present → `workspace-write`, else `read-only`). Emitted TOML is byte-identical for all 35 roles today: 17 roles that would derive broader are held at `read-only` behind an explicit, self-invalidating hold list (`CODEX_SANDBOX_HOLDS`) pending a decision on whether Codex enforces `sandbox_mode`. The 17th was surfaced only by review: the tools reader was single-line, so a YAML list-form `tools:` block returned just its first item and `gsd-nyquist-auditor`'s declared `Write`/`Edit` were read as an absence. **Deriving from a declaration you cannot parse is not deriving** — the reader now handles both shapes, and the role joined the hold list rather than the count being left flattering. **That conflict was surfaced rather than resolved silently:** §8.3's own criterion asks both that the sandbox *derive from the declared tool contract* and that *no role gain a broader sandbox*, and those cannot both hold — a faithful derivation widens 17 roles that the deleted map never listed and that fell through its silent `|| 'read-only'` default. The resolution taken is derive-and-hold: the derivation becomes the single owner of the rule now, and each hold is released as its role's enforcement question is answered. A hold is reversible; a widened sandbox that turns out to be enforced is not. `checkAgentsInstalled` (`src/agent-install-check.cts`) still checks presence only; the semantic assertion is a sibling function, `checkCodexSandboxPosture`, wired into `validate agents`'s `sandbox_posture` field — report-only, exit 0, matching the pre-existing `codex_posture` precedent, not folded into `checkAgentsInstalled` itself. |
> | "The `shortFormToId` rule below is accurate — no such tier exists on `next`" | **Now built.** `resolveDependencyId` (`src/phase.cts`) gained the third, in-phase-only tier recovered verbatim from the retired SDK lineage (`sdk/src/query/phase.ts` at `11918dcc3^`): `depends_on: ["01"]` resolves to the sibling plan whose canonical id ends `-01`, first-write-wins on a same-phase collision. The display mapping at `phase.cts:961` stays passthrough by design (#3785) — this tier is not routed through it. |
>
> The guard-roster line above is unaffected: no lint guard is retired by this rung, only the hand-maintained map and the four marker-reader copies.

**Rule — consolidation carries invariants forward explicitly.** A lineage consolidation may not delete an invariant along with the surface that held it. The `shortFormToId` tier existed in the retired SDK lineage; the surviving lineage never received it, the gap was recorded only in an archived changeset and a `// KNOWN GAP:` comment, and both went away with the surface (#3427). **A parity note in an archived changeset is not a tracking mechanism.**

#### 8.4 Failure is a value — *Required — phase unassigned*

**Rule.** Every routine that can fail returns `Result`. `parseNamedArgs` rejects unrecognized and positional tokens with a non-zero exit — it is called by agents that will drift again.

**Rule.** A count query returns `0`, not `""`, and never `""` with exit 0 (#3365).

#### 8.5 No silent swallow, and no verdict manufactured from dropped data — *Required — phase unassigned*

**Rule.** A swallowed `catch` may not fold a fatal errno into a retry set. A synthesis step may not emit its artifact when its inputs failed (#3352). A derived conclusion may not be reported as authoritative when the derivation dropped input it could not resolve (#3427).

**Rule.** `searchJsonEntries` / `matchesInValue` restore the `MAX_JSON_SEARCH_DEPTH = 48` recursion bound lost in the ADR-0174 consolidation. `src/intel.cts` recurses through arrays and objects with **no depth parameter at all**, so deeply nested intel JSON overflows the stack. This has no issue of its own — it is tracked HERE and nowhere else.

#### 8.6 The state transaction — *Required — Phase 1*

**Question.** What may apply the STATE.md sync-and-preservation pipeline, and under what precondition?

**Owner.** `src/state-transition.cts` · the transaction type, constructed by `open()` or `rebuild()`.

**Rule — the snapshot is mandatory in both constructors.** A transaction cannot be constructed without the pre-write frontmatter snapshot. An absent snapshot is a **construction failure**, per Decision 2's first row — not a runtime no-op. Today the executor reaches a declared `preserve-always` row with a null snapshot and skips it silently, which is how a curated `progress` block is zeroed by verbs that have nothing to do with progress (#3756).

**Rule — the two constructors differ in preservation, not in snapshot.** `open()` applies preservation. `rebuild()` does not. Both carry the snapshot, because §8.7's reporting needs it regardless of whether preservation ran.

**Rule — `rebuild()` is the typed expression of the sanctioned exceptions.** ADR-3408 §8.3's closed list of commands whose contract is to let the body win — `cmdStateSync` (#905: `state sync` re-derives frontmatter *from* the body) and `/gsd-health --repair`'s `REGENERATE_STATE` (a factory reset) — call `rebuild()`. They are **not** debt: a guard reporting them is reporting correctly, and a change that removes one is a regression. Adding to the list is an amendment to ADR-3408 §8.3.

**Consequence for the guard.** The write-path drift baseline's two `sanctioned-permanent` entries are retired, and the baseline file with them: the exception becomes a constructor the type system names, not a ratcheted string match. `scripts/lint-state-write-path-drift.cjs` keeps every check the type does **not** make unrepresentable.

> **Amendment, 2026-08-25 (Phase 1, #3871) — this paragraph originally read "keeps only its raw-write check (`fs.writeFileSync` against the state path)", and that sentence was wrong on both halves.** Verified against `next` while implementing: the guard contained **no raw-write check at all**, and it contained **four** checks besides the one §8.6 retires — policy-dispatch drift, unimplemented policies, unstripped content writes, and prompt-layer state writes. None of those is named by §8.6 and none is made unrepresentable by the transaction type, so all four are retained; the raw-write check is **net-new**.

> It is kept — rather than dropped along with the sentence that mis-described it — because of what it covers, not because §8.6 named it. `writeStateMd` acquires the STATE.md lockfile before it writes; a raw `fs.writeFileSync` against the state path acquires nothing. That is not a preservation bypass, it is a **lock** bypass, and lost-update is the #500/#905/#1230 family. Every other route into the file is now closed by construction — an `open()` transaction preserves, a `rebuild()` transaction is the typed exception, and a re-assembled composition is caught by the axis above — so the raw write is the one remaining reachable path that nothing covers. Zero occurrences to date is not the test; reachability and blast radius are.
>
> The tempting counter-precedent does **not** apply. ADR-3408 §8.6's amendment deleted the `clear` preservation policy when it turned out no row used it and no executor existed — contract names X, X does not exist, delete the naming. `clear` was dead *vocabulary* in a closed enum: deleting it removed a way to express something meaningless. This is coverage of a *reachable path*. The two look alike and are not the same shape.
>
> The retired axis was the **seam-bypass** scan, and only half of it was redundant. Its `writeStateMd(` arm is genuinely replaced by the type and is gone with its ratchet. Its **composition-bypass** arm — a new call site re-assembling `syncStateFrontmatter` + `applyPostSyncPreservation` instead of routing through the owned composition, which is ADR-3408 §8.3's rule and the exact shape #3469 found live in `cmdPhaseComplete` — is **not** replaced by the type, which gates one parameter of one function and nothing more. It is retained, made terminal rather than ratcheted, and carries its own reason code. Decision 6 sanctions retiring a guard the change makes **redundant**; deleting this arm would have been a silent coverage regression dressed as a guard-count win, which is precisely the Goodhart outcome Decision 6 exists to prevent.

#### 8.7 What a command reports it wrote — *Required — Phase 2*

**Question.** Which fields appear in a command's `updated` array?

**Owner.** `src/state.cts` · the transaction diff.

**Rule.** `updated` is derived by comparing persisted frontmatter against the transaction's snapshot. **A field appears in `updated` iff its persisted value changed.** This restates ADR-3408 Decision 4 and is not new; what is new is that it holds for *every* field.

**Rule — no field is excluded by classification.** `reconcileReportedFields`'s `progress` exclusion is **deleted, not relocated.** It exists to dodge the #1264 regression where `progress` was reported as `updated` on every write that merely preserved it — but under a real diff a preserved field is unchanged and does not appear, so the diff fixes #1264 by construction. The exclusion's only remaining effect is to suppress genuine changes (#3743).

**Rule — reporting granularity is the dotted leaf path.** `progress.total_plans`, not `progress`. This is already the output convention (#3818, #3743).

**Consequence.** "Reported but not persisted" (#3351) was made unrepresentable by ADR-3408 Phase 3. "Persisted but not reported" (#3345, #3743, #3818, #3835, #3836) survived through the exclusion list, and this rule closes it.

**Prior art — the mechanism is already proven at one site.** `fix(#3685)` (`7b2f2c89f`, `src/phase.cts`) replaced `phase complete`'s `fs.existsSync`-derived `roadmap_updated` / `state_updated` flags with flags derived from the transaction's content diff, so a no-op write stopped being indistinguishable from a successful one. That is this rule at file granularity. Phase 2 applies the same derivation at **field** granularity in `reconcileReportedFields`, and should be read as generalizing #3685 rather than re-deriving it.

#### 8.8 The STATE.md schema — *Required — Phase 3*

**Question.** Where is the set of STATE.md keys, their types, enums, cardinality, preservation policy and accepted parse shapes declared?

**Owner.** One `.cts` schema module. `FIELD_CLASSIFICATION` becomes a projection of it, not a sibling of it.

**Rule — generated artifacts.** `gsd-core/templates/state.md` and `docs/reference/state-md.md` are **generated and committed**, with a CI drift check. This follows the repo's established pattern (`gen-inventory-manifest.cjs`, `gen-section-manifest.cjs`, `gen-context-index.cjs`, `gen-health-docs.cjs`).

**Rule — the locales.** The schema-derived tables (field reference, status values, cardinality) and the **section skeletons** are generated into all five locales — `docs/reference/state-md.md` and its `ja-JP`, `zh-CN`, `ko-KR`, `pt-BR` siblings. Column headers come from a per-locale string table; prose sections stay hand-translated. A locale missing a section the schema declares **fails CI** rather than going unnoticed.

*Why this rule is normative rather than a nicety:* on `next` @ `e40e9670f` the English reference is 225 lines and all four translations are 203. The English `### Status lifecycle (ADR-2207)` section is **absent from every translation** — and it documents the `status` enum whose clobbering is #3853. The drift is not hypothetical and it is not cosmetic.

**Rule — parsers are checked, not generated.** Parse functions stay hand-written. A test asserts they accept **exactly** the shapes the schema declares — no more, no fewer. Generating a parser is a substrate decision this epic does not take; the shape-proliferation family (#3784's three spellings of "plan N of M") is closed by declaring the accepted set, not by emitting the matcher.

**Consequence for the guard.** Field drift between the schema, the template and the docs stops being *representable*, because the artifacts are generated from the schema and a drift check refuses a stale one.

> **Amendment, 2026-08-26 (Phase 3, #3873) — this paragraph originally instructed deleting `scripts/lint-state-field-drift.cjs` (805 lines) on the grounds that it detected that drift. Verified against `next`: it does not, and never did.** That script's own header declares it the drift guard for the **STATE.md field-extraction fallback chain** — epic #3180, issue #3187, ADR-3180 Decision 4 §7.7. It detects re-derivations of the *"prefer the frontmatter scalar, else fall back to the body field"* coercion ladder across `src/**` and the prompt layer. It contains no reference to `FIELD_CLASSIFICATION`, to the template, or to the reference docs. Nor does any **other** script own field/template/docs drift — the full `scripts/` inventory carries none. The instruction named a guard surface that did not exist.
>
> **The guard is therefore retained**, and `tests/lint-state-field-drift-retained.test.cjs` pins that decision so a future reader does not delete it on this ADR's earlier word. A key-set schema makes a *key-set disagreement* unrepresentable; it does nothing about a *code-shape* re-derivation of a coercion ladder. Those are orthogonal, and Decision 6 sanctions retiring a guard the change makes **redundant** — which this one is not.
>
> **This is the second guard-retirement claim in this ADR to rest on a wrong premise**, after §8.6's (see its own amendment). Both described a guard surface their author believed existed. The pattern is worth naming: a retirement claim in this ADR is a *hypothesis about a guard's contents*, and Decision 6's ledger requirement should be read as obliging the implementing phase to verify that hypothesis before acting on it — not merely to count the result.

#### 8.9 Each subsumed child is driven fail-first — *Required — every phase*

**Rule.** #2986, #3372, #3364, #2540, #3231, #3349, #3360, #3358, #3365, #3356, #3352, #3427 — and the STATE.md set #3756, #3743, #3818, #3835, #3836, #3853, #3812 — each get a failing-first regression test driven green via `gsd-test`, **plus** a behavioral identity test asserting at the *consumer's* output per ADR-3180 Decision 4(b). A structural guard alone would not have caught these.

**Rule.** Following ADR-3180 §6's precedent, each phase **names** the issues it subsumes and records the evidence the symptom is gone; it does **not** unilaterally close them. Whether a subsumed issue is closed, re-scoped, or kept open for its own regression test is the maintainer's call at merge time.

## Consequences

**Breaking changes.**

- **`parseNamedArgs` becomes strict** (§8.4). A previously-silent typo now exits non-zero. Intended — the silent path corrupts STATE.md — but it changes observable CLI behavior. Needs a changeset and a `Changed` entry.
- **`--pick` returns `0` rather than empty** for absent counts. Anything distinguishing empty-from-zero changes.
- **Frontmatter serialization output may differ cosmetically** once a real parser owns it (§8.1). Round-trip values must be identical; golden fixtures will need regeneration.
- **`updated` arrays grow** (§8.7). Callers that assumed `progress` never appears will now see `progress.*` leaves when it genuinely changed. This is the fix, not a regression.

**Guard ledger, Phases 1–3.**

| Phase | Guard | Δ |
|---|---|---|
| 1 (§8.6) | `lint-state-write-path-drift.cjs` — seam-bypass `writeStateMd(` arm and its whole ratchet apparatus retired, baseline file deleted; composition-bypass arm retained and made terminal; raw-write check **added net-new** | **−665 lines, −1 file, +1 check** — net shrink |
| 2 (§8.7) | none — the reporting diff makes no guard redundant | **0**, stated rather than omitted |
| 3 (§8.8) | `lint-state-field-drift.cjs` — **retained**, see §8.8's amendment; a generated-artifact drift check and a locale-parity check are **added** | **+2 checks, 0 retired — this phase GROWS** |
| — | `lint-planning-snapshot-bypass-drift.cjs` — extended to the write side by ADR-3180 Amendment 8 | **growth, declared** |

Net across the set: one guard retired, one increase recorded honestly. The increase belongs to a concurrent lane under a different ADR and is listed here so the accounting is complete rather than flattering.

**Everything else is internal.** Deleting an inline copy in favour of the canonical implementation changes behavior only where the copy was already wrong, which is the defect being fixed.

## Alternatives considered

- **Keep fixing them individually.** This is the status quo and is what produced the queue: 10 of the 30 surveyed issues are re-filings of an already-closed fix. Rejected on evidence.
- **Add more drift guards.** Tried, at scale — 65 rules and guards. Decision 5's two demonstrations show a guard live at `error`, aimed at the exact defect class, that the shipped defect walked past. Detection matches the fingerprint of the last bug; it cannot cover a class. Rejected.
- **Keep the hand-rolled YAML to preserve the near-zero-dependency posture.** The posture is defensible for an `npx`-distributed CLI, but the cost was never priced: owning the parser means owning escaping, CRLF, quoting and indentation permanently. §8.1's vendoring rule preserves the posture *and* retires the dialect. Rejected as stated; preserved as amended.
- **Adopt `remark`/`mdast` for the markdown half.** Rejected: `src/markdown-sectionizer.cts` and `src/markdown-table.cts` already exist as canonical seams. The markdown problem is not a missing seam, it is a **non-mandatory** one — #3426/#3239 sit outside the enforcing glob. A coverage fix, not a substrate decision.
- **Fold derivation authority into this ADR.** Rejected. ADR-3180 §7.5 already locks the sentence this rule generalizes, and splitting the derivation contract across two ADRs is the exact drift shape both epics exist to stop. It lands as ADR-3180 Amendment 8.
- **One epic per family (three epics).** Rejected by the maintainer: a single owner prevents the three mechanisms from being fixed against each other while the work is in flight.

## Software laws applied

- **Greenspun's Tenth Rule** — the hand-rolled YAML dialect (§8.1) and the `FIELD_CLASSIFICATION` table's five accretions are both a general-purpose language being reinvented inside the application. §8.6's closed guard vocabulary exists so the table does not become an interpreter.
- **Goodhart's Law** — Decision 6's ledger rule. "Net guard count falls" is a measure one phase away from becoming a target; the defence is that an increase must be declared in the same ledger.
- **Postel's Law** — Decision 2's bright line. Strict on internal system-to-system boundaries where both ends are controlled; liberal on user documents.
- **Hyrum's Law** — the `updated` array's growth under §8.7 is an observable-behavior change even though it is a bug fix, and is called out under Consequences rather than assumed benign.

## Cross-references

- [ADR-3180](3180-planning-semantic-model-single-owner.md) — read-side derivation ownership; Decision 4 (a)–(e) adopted verbatim; Amendment 8 owns derivation authority.
- [ADR-3408](3408-state-write-path-preservation.md) — STATE.md write path; §8.3's sanctioned-exception list is normative for §8.6.
- [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) / [ADR-1372](1372-markdown-sectionizer-seam.md) — the document-parsing layer beneath this one.
- [ADR-3212](3212-lexical-seam-consolidation.md) — the lexical layer beneath that.

## Guard roster

| Guard | Status under this ADR |
|---|---|
| `scripts/lint-state-write-path-drift.cjs` | retained, shrunk (§8.6) — seam-bypass `writeStateMd(` arm and its ratchet retired at Phase 1; composition-bypass arm retained and made terminal; raw-write check added net-new. See §8.6's amendment. |
| `scripts/lint-state-field-drift.cjs` | **RETAINED** — the Phase-3 retirement instruction rested on a wrong premise about what this guard does; see §8.8's amendment. It guards the ADR-3180 §7.7 / #3187 coercion ladder, which no schema makes unrepresentable. |
| `scripts/lint-vendored-deps.cjs` | **not reusable as-is** — generalized to a manifest by §8.1; see the correction below |
| `local/no-external-require-in-bin` | reused as-is; enforces §8.1's packaging rule |
| `local/no-adhoc-markdown-parsing` | widened past `src/**/*.cts` per Decision 5 (coverage fix, tracked on #3426/#3239) |
| `local/no-adhoc-regex-escape` | widened to `MemberExpression`/`TSAsExpression` with a `.source`-aware exemption (§8.3) |
| `scripts/lint-frontmatter-scalar-broad-grep.cjs` | **NOT a casualty of §8.1 — retained.** See the correction below. |
| `scripts/lint-phase-enumeration-drift.cjs` | expected casualty of §8.2 — **verify before retiring** (Phase 5) |

> **Correction, 2026-08-26 (Phase 4, #3881) — two rows in this roster were wrong, and they are the
> FOURTH and FIFTH wrong premises in this ADR.** Both were caught by applying the rule recorded in
> §8.1's amendment — *a factual claim in this ADR is a hypothesis until the implementing phase
> executes it* — on its first use.
>
> **`lint-frontmatter-scalar-broad-grep.cjs` is not a casualty of §8.1 and is retained.** It has
> nothing to do with the TypeScript parser. It is `DEFECT.FRONTMATTER-SCALAR-BROAD-GREP` (#586 /
> PR #650): it scans fenced ```bash / ```sh blocks in `gsd-core/workflows/*.md`, `agents/*.md` and
> `commands/**/*.md` for shell `grep "^key:"` invocations that read a frontmatter scalar from the
> whole markdown body instead of scoping to the frontmatter block — the failure that once yielded
> `passed+gaps_found+human_needed` instead of `passed` and blocked a passing phase. **The prompt
> layer does not call our parser; it runs `grep` in a shell.** Vendoring js-yaml makes a shell grep
> no safer, so retiring this guard would be a pure coverage loss dressed as a guard-count win —
> the Goodhart outcome Decision 6 exists to prevent, and the third time in this epic that a
> retirement claim has pointed at a guard whose actual contents it did not describe.
>
> **`lint-vendored-deps.cjs` cannot be "reused as-is."** All four of its checks name `re2js`
> literally, as does its `REFRESH_COMMAND`. Vendoring a second package by pasting a second hardcoded
> block would violate **§8.3, "one implementation per rule"**, inside the epic that exists to end
> that. Phase 4 generalizes it to a table-driven manifest, preserving re2js's four checks unchanged.
>
> A further wrinkle the roster did not anticipate: js-yaml ships **no type declarations** and
> `@types/js-yaml` is not installed, so the re2js precedent's verbatim `.d.cts` copy has no upstream
> to copy from. `src/vendor/js-yaml.d.cts` is hand-authored, declaring only `load`, `dump`,
> `FAILSAFE_SCHEMA` and `YAMLException` — which also makes anchors, aliases and custom types
> unreachable from typed code, a capability gate rather than a shortcut. It is therefore excluded
> from the byte-compare and pinned by a test instead.

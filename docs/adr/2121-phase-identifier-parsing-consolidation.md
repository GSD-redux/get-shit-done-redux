# ADR-2121: Phase-Identifier Parsing Consolidation

- **Status:** Accepted (Phase 0 — ADR only; locks the contract Phases 1–4 execute against. No production code lands in this PR.)
- **Date:** 2026-07-09
- **Issue:** [#2121](https://github.com/open-gsd/gsd-core/issues/2121) — epic (tech-debt / root-cause consolidation, `type: chore` + `approved-enhancement`)
- **Supersedes:** nothing
- **Relationship to prior work:** completes [#1455](https://github.com/open-gsd/gsd-core/issues/1455) (which introduced the prefix-tolerant lookup source but only in `roadmap-parser.cts`); it is the parser-layer analog of the `package-identity.cjs` single-source seam (ADR-referenced by `scripts/lint-package-identity-drift.cjs`).

## Context

Phase-identifier parsing — turning a phase reference (`3`, `03`, `12A`, `2.7`, `2-01`, `CK-01`, `AB-29`, `Milestone v0.5 complete`) into a normalized identity, a ROADMAP heading match, or a resolved phase — is **implemented independently in at least six modules**. `src/phase-id.cts` exists and is *meant* to be the canonical normalizer, but the surrounding modules each roll their own regex instead of delegating. A fix or invariant lands on one surface and its siblings silently diverge, so the same defect keeps re-surfacing under new issue numbers.

This is exactly the class `CLAUDE.md` warns about under **Generative Fix Divergence**:

> When sharing constants/arrays/parsers between parallel surfaces, add a parity assertion test that fails if they diverge.

The guard rule exists in the standards, but it is not applied to phase-ID parsing. Three confirmed bugs are the direct consequence:

| Symptom issue | Site | Divergent behavior | Blocked? |
|---|---|---|---|
| [#2111](https://github.com/open-gsd/gsd-core/issues/2111) | `state.cts:parseProsePhaseField` (`state.cts:1118-1131`) | `/\b(\d+[A-Z]?(?:\.\d+)*)\b/i` mines the *first* numeral in a prose `Phase:` line; `Milestone v0.5 complete` → `5`, `v1.0` → `0` (a reserved sentinel). `milestone complete v0.5` writes `current_phase: 5` instead of the real last phase. | No |
| [#2114](https://github.com/open-gsd/gsd-core/issues/2114) | `roadmap.cts:cmdRoadmapGetPhase` (`roadmap.cts:238-303`) + `getRoadmapPhaseWithFallback` (`roadmap.cts:209-234`) | Both hand-roll a **2-source** lookup (exact → numeric). `getRoadmapPhaseInternal` (`roadmap-parser.cts:262-287`) loops a **3-source** pass (exact → numeric → prefix-tolerant) via `roadmapPhaseLookupSources`. `roadmap get-phase 29` returns empty for `### Phase AB-29:` while `init.phase-op 29` resolves it. | No |
| [#2104](https://github.com/open-gsd/gsd-core/issues/2104) | `phase-id.cts:normalizePhaseName` / `stripProjectCodePrefix` (`phase-id.cts:44-77`) | `PROJECT_CODE_PREFIX_STRIP_RE_I = /^[A-Z][A-Z0-9_]*-(?=\d)/i` strips *any* prefix-shaped token with no check against the configured `project_code`; `MEM-01` collapses to bare `01` even when the project code is `LKML`. The #2056 guard was added to `cmdInitPlanPhase` only; the three sibling init commands still collapse foreign prefixes. | **Yes — sequenced after PR #2105 (#2056)** |

### Why #1455 did not close the loop

`git show 2dedbdd11` (fix(#1455)) touched `phase-id.cts`, `phase.cts`, `roadmap-parser.cts`, `roadmap-upgrade.cts`, `validate.cts` — **not `roadmap.cts`**. It added `OPTIONAL_PROJECT_CODE_PREFIX_SOURCE` (`phase-id.cts:24`) and the third lookup source inside `roadmapPhaseLookupSources` (`roadmap-parser.cts:245-260`), but `roadmap.cts` never imported the constant. The mechanical root of #2114 is an import-list asymmetry: `roadmap.cts:16-17` destructures seven names from `phase-id.cjs` but omits `OPTIONAL_PROJECT_CODE_PREFIX_SOURCE`, so it *structurally cannot* build the prefix-tolerant source today. A point fix on `roadmap.cts` would leave the divergence itself — one seam missing, N call sites free to re-diverge — fully intact.

### The full divergent surface (broader than the three modules the issue names)

Memtrace blast-radius analysis (`get_impact normalizePhaseName` → **risk CRITICAL, 84 affected symbols, 20 direct callers across 19 files**) and a symbol sweep surfaced the complete surface. This matters because it bounds both the back-compat risk and the guard's scope:

- **`phase-id.cts` (the partial canonical seam, 272 lines, pure — "no Node built-ins").** Already owns: `escapeRegex` (`:15`), `OPTIONAL_PROJECT_CODE_PREFIX_SOURCE` (`:24`), `OPTIONAL_PHASE_TAG_SOURCE` (`:42`), `stripProjectCodePrefix` (`:44`), `normalizePhaseName` (`:54`), `getMilestoneFromPhaseId` (`:79`), `getPhaseDirFromPhaseId` (`:88`), `phaseMarkdownRegexSource` (`:107`), `phaseMarkdownRegexSourceExact` (`:138`), `comparePhaseNum` (`:144`), `extractPhaseToken` (`:197`), `phaseTokenMatches` (`:247`). It does **not** parse-from-prose, and its regex-source builders are consumed by callers, not applied here.
- **`state.cts` — five independently-maintained phase-token regex shapes:** `parseProsePhaseField` (`:1120`, the `\b…\b` miner), its unanchored twins `resolvePhaseIdForCompletePhase` (`:2722`) and `cmdStateCompletePhase` (`:2750`), the `Phase`-anchored `extractRetiredPhaseNumbers` (`:1319`), the strip/pad idiom in `cmdStateValidate` (`:2291`,`:2294`), and the digits-only dir shape in `phaseInventoryProvider` (`:2642`). Only `phaseKeyFromToken`/`phaseKeyFromDir` (`:1283-1288`) delegate to `phase-id.cjs`.
- **`roadmap.cts` — four regex-construction sites** (`:410`, `:528`, `:787`, plus the two named CLI functions). The three standalone sites already use the canonical `phaseMarkdownRegexSource` builder; only the two named functions diverge (no prefix-tolerant source).
- **`roadmap-parser.cts`** — `roadmapPhaseLookupSources` (`:245`, the canonical 3-source ordering), `getRoadmapPhaseInternal` (`:262`, the one impure resolver), `findRoadmapPhaseInContent` (`:214`).
- **`init.cts`** — on `next` today, init resolves a phase query through the config-blind `stripProjectCodePrefix` / `normalizePhaseName` path (`init.cts:76`, `:1184`), so its three sibling commands (`cmdInitExecutePhase`, `cmdInitVerifyWork`, `cmdInitPhaseOp`) collapse foreign-prefixed IDs (the #2104 symptom). The config-aware guard family (`parsePhasePrefix` / `isForeignPrefixedPhaseQuery` / `roadmapPhaseMatchesExactPrefix`, with `/^([A-Z][A-Z0-9_]*)-(?=\d)/i`) is being introduced by #2056 on the **unmerged PR #2105** (`fix/2056-plan-phase-foreign-prefix`) and is **not yet on `next`** — it is **Cluster 1 / #2104 domain**, and its line numbers are omitted here deliberately because they will drift when #2105 lands.
- **`validate.cts`** — `buildNotStartedPhaseVariants` with its own `Phase\s+([\w][\w.-]*)` regex; `phaseVariants`.
- **Two distinct ROADMAP content matchers:** `searchPhaseInContent` (`roadmap.cts:126`, uses `OPTIONAL_PHASE_TAG_SOURCE` + a checklist fallback + `tokenizeHeadings`) vs `findRoadmapPhaseInContent` (`roadmap-parser.cts:214`).
- **`escapeRegex` is duplicated** in `phase-id.cts:15` and `state-document.cts:11`.

Per `CONTRIBUTING.md`:

> **One issue = one ADR-or-PRD = one PR.** Do not batch multiple decisions into one file or one PR.

This ADR is that one file. It decides and **locks** the target seam; it ships no production code. Phases 1–4 execute against it as separate PRs.

## Decision

Make `src/phase-id.cts` the **single canonical owner** of every phase-identifier operation, migrate the divergent consumers to delegate to it, and add a machine-enforced anti-divergence guard so no future module can re-implement phase-ID parsing without failing CI. Seven decisions, locked below.

### 1. `phase-id.cts` is the sole owner of phase-identifier parsing

"Phase-identifier parsing" is defined as the closed set of operations: **normalize**, **compare**, **project-code prefix policy**, **parse-from-prose**, **parse-from-heading (regex-source construction + lookup-source ordering)**, **parse-from-dir-name (token extraction + match predicate)**, and **parse-from-CLI-query**. Every function in that set lives in `phase-id.cts` (or, for the one operation that must touch the filesystem, in the single resolver named in Decision 5). Consumers `require`/`import` the canonical functions; **no consumer defines a phase-identifier regex locally.**

*Rejected:* (B) a new `phase-resolver.cts` module — rejected because `phase-id.cts` already holds twelve of these functions and 20 direct callers; a new module would create a *second* seam and worsen the divergence it aims to fix. (C) leave parsing distributed but add a lint that all sites match a golden regex — rejected because it enforces textual sameness, not single-ownership, and cannot cover the semantic divergences (`\b…\b` vs unanchored vs `Phase`-anchored are all "valid" regex).

### 2. Extend, never mutate — the backward-compatibility guarantee (Hyrum's Law)

`normalizePhaseName` has a **CRITICAL** blast radius (84 affected symbols, 20 direct callers, 19 files). Its observable behavior — zero-padding, unconditional prefix stripping, letter-case preservation (`#1962`), milestone-form decomposition — is depended upon everywhere. **Locked:** Phases 1–4 may only *add* exported functions to `phase-id.cts`; they may **not** change the observable behavior of any of the twelve existing exports. Any behavior change to an existing export (including "fixing" the config-blind strip in place) is out of scope for this epic and requires its own ADR. The #2104 fix is delivered as a **new, config-aware** function (Decision 4), leaving the existing config-blind path untouched for its 20 callers.

### 3. The locked canonical surface (the exports Phase 1 adds)

Phase 1 adds exactly these pure functions to `phase-id.cts`. Signatures and contracts are **locked**; Phases 2–4 consume them verbatim.

**`parsePhaseFromProse(value: string | null): { phase: string | null; name: string | null }`**
The anchored replacement for `state.cts:parseProsePhaseField`. It extracts a phase identifier **only** from a genuine phase reference — the literal token `Phase <id>` (optionally `Phase <id>: <name>`, `Phase <id> — <name>`, or `Phase <id> of <M>`). Invariants this seam pins:
- A milestone-completion string carries **no** phase: `parsePhaseFromProse('Milestone v0.5 complete')` → `{ phase: null, name: null }` (fixes #2111). Likewise `v1.0`, `v2.10`, and any `Milestone v…` form.
- A real reference parses: `'Phase 3A — Delta (executing)'` → `{ phase: '3A', name: 'Delta' }`.
- It never mines a stray numeral from surrounding prose; absence of a `Phase` anchor yields `{ phase: null }`, not a guessed number.

**`stripConfiguredProjectCodePrefix(value: unknown, projectCode: string | null | undefined): string`**
The config-aware prefix stripper. Strips a leading `<CODE>-` **only** when `<CODE>` case-insensitively equals `projectCode`; a foreign prefix (`MEM-` when the code is `LKML`) or an absent/empty `projectCode` leaves the value **verbatim**. This is the canonical home for the #2104 fix. It *complements* — does not replace — the existing config-blind `stripProjectCodePrefix` (Decision 2).

**`isForeignPrefixedPhaseQuery(phase: unknown, projectCode: unknown): boolean`**
The canonical predicate that #2056's guard family — arriving on the **unmerged PR #2105**, not yet on `next` — will delegate to once it lands: `true` when `phase` carries a prefix that is not the configured `projectCode`. Locking it here means #2105's `cmdInitPlanPhase` guard and the three #2104 sibling commands share **one** foreign-prefix rule instead of the divergent copies they would otherwise seed.

**`roadmapPhaseLookupSources(phaseNum: unknown): string[]`** *(moved from `roadmap-parser.cts:245-260`)*
The canonical heading lookup-source builder becomes an owned export of `phase-id.cts` (it is already pure — it only composes regex-source strings). All three roadmap call sites consume it, so the ordering (Decision 5) has exactly one definition.

**Parse-from-CLI-query — no new function (locked).** A CLI-supplied phase argument (`gsd-tools … <phase>`) is resolved by *composing existing locked primitives*, not a new parser: `extractPhaseToken` / `normalizePhaseName` (token + normalize, Decision 2) → `isForeignPrefixedPhaseQuery` / `stripConfiguredProjectCodePrefix` (config-aware prefix policy, Decision 4) → `phaseTokenMatches` for dir-name resolution or `roadmapPhaseLookupSources` → `getRoadmapPhaseInternal` for heading resolution. This is deliberately *not* a distinct `parseCliQuery` function: callers already know they hold a CLI arg, and a discriminated god-parser would re-widen the accept surface (Postel's Law). The lock is that CLI-query resolution routes through these primitives only — no consumer re-derives a phase from a CLI arg with its own regex.

*Rejected:* (B) fixing `parseProsePhaseField` in place with a tighter regex but leaving it in `state.cts` — rejected because the fix would not be reusable by the other prose sites and would re-seed the divergence. (C) a single mega-parser `parsePhaseId(input, kind)` with a `kind` discriminator — rejected (Postel's Law / interface clarity): callers already know whether they hold prose, a heading, a dir name, or a CLI arg; a discriminated god-function hides that and widens the accept surface.

### 4. Project-code prefix policy — config-aware stripping is the resolution path

**Locked policy:** a project-code prefix is a *display* prefix. For **identity/normalization** where config is unavailable, the config-blind `stripProjectCodePrefix` remains (back-compat). For **resolution of a caller-supplied query** (init commands, roadmap lookup) the config-aware `stripConfiguredProjectCodePrefix` / `isForeignPrefixedPhaseQuery` are the path: a query whose prefix is *not* this project's code must not collapse to a bare number and match a foreign phase. This tightens an over-liberal accept surface (Postel's Law) without touching the 20 callers of the blind stripper.

### 5. Lookup-source ordering — the locked invariant

The canonical resolution tries sources in this exact, de-duplicated order (as `roadmapPhaseLookupSources` implements today at `roadmap-parser.cts:251-259`):

1. **Exact** — `phaseMarkdownRegexSourceExact(phaseNum)` — non-null only when the query itself carries a prefix; matches `### Phase PROJ-42:` verbatim.
2. **Numeric / padding-tolerant** — `phaseMarkdownRegexSource(phaseNum)` — the canonical bare heading (`### Phase 42:`), padding-tolerant (`0*N`).
3. **Prefix-tolerant** — `` `${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}${numericSource}` `` — the drifted-only fallback (`### Phase MANIFOLD-117:` for a bare `117` query), de-duplicated via `[...new Set(sources)]`.

**Order matters and is locked:** bare-numeric is tried *before* prefix-tolerant so a canonical heading wins over a drifted one when both exist. The single impure ROADMAP resolver is **`getRoadmapPhaseInternal` (`roadmap-parser.cts:262`)** — it reads `ROADMAP.md` and loops these sources. `roadmap.cts`'s CLI siblings (`cmdRoadmapGetPhase`, `getRoadmapPhaseWithFallback`) **delegate to it** rather than re-scanning content, collapsing the `searchPhaseInContent` vs `findRoadmapPhaseInContent` duplication onto one resolution path — this is precisely the delegation #2114 requests.

### 6. Migration order & backward-compatibility guarantees

Each phase is its own small PR, opened under a fresh `chore(#2121): … — Phase N` sub-issue, and lands **in order** — Phase N+1 does not begin until Phase N merges. No phase changes any observable CLI output **except** the corrected resolution for the cited symptom cases.

| Phase | Scope | Drives green | Sub-issue |
|---|---|---|---|
| **0** | This ADR — lock the contract. No production code. | — | Closes #2121 |
| **1** | Add the Decision-3 functions to `phase-id.cts`; move `roadmapPhaseLookupSources` in. Exhaustive unit tests + boundary cases (`v0.5`, `v1.0`, `MEM-01`, `AB-29`, bare `29`, zero-padded `029`) + ≥1 `fast-check` property test for the parse↔normalize contract. **No consumer changes.** | — | new |
| **2** | Migrate `state.cts` prose/number sites (`parseProsePhaseField` → `parsePhaseFromProse`; the unanchored twins `resolvePhaseIdForCompletePhase`, `cmdStateCompletePhase`; align the dir/pad shapes on `extractPhaseToken`/`normalizePhaseName`). Regression-first: assert `current_phase` survives a `milestone complete v0.5` close unchanged. | **#2111** | new |
| **3** | Delegate `roadmap.cts:cmdRoadmapGetPhase` + `getRoadmapPhaseWithFallback` to `getRoadmapPhaseInternal` / `roadmapPhaseLookupSources`. Regression-first: `roadmap get-phase <bare-N>` resolves `### Phase AB-N:`, and both CLI siblings route through the same lookup sources as the internal resolver. | **#2114** | new |
| **4** | Add the Decision-7 anti-divergence guard; inventory-sweep the remaining sites. | closes the recurrence loop | new |

**#2104 disposition (locked):** Phase 1 builds the config-aware prefix API (Decision 4) so #2104's fix has a canonical home, but **#2104's own migration** (applying the guard to `cmdInitExecutePhase` / `cmdInitVerifyWork` / `cmdInitPhaseOp`) is **blocked on PR #2105 (#2056)** — the guard helpers it must reuse do not exist on `next` yet — and stays tracked on #2104, **outside this epic's critical path**. Phases 1–4 must not block on #2104, and #2104's init sites are allowlisted by the Phase-4 guard (Decision 7) until #2105 lands.

### 7. The anti-divergence contract (the parity guard)

**Locked mechanism**, modeled on the repo's two proven single-source patterns — `tests/capability-precedence-parity.test.cjs` (identity guard) and `scripts/lint-package-identity-drift.cjs` + `tests/package-identity.test.cjs` (drift scanner):

1. **Identity guard test** — for every consumer that re-exports a canonical phase-ID function, assert reference identity: `assert.strictEqual(consumer.fn, phaseId.fn)`. A pasted re-implementation is a different function object and fails instantly (the mechanism `capability-precedence-parity.test.cjs:44-51` uses).
2. **Drift scanner** — `scripts/lint-phase-id-drift.cjs` exports a **pure** `findPhaseIdRegexDrift(text, opts)` that flags phase-ID-shaped regex literals (`\d+[A-Z]?(?:\.\d+)*`, `[A-Z][A-Z0-9_]*-`, and `Phase\s+…:` heading builders) defined in any `src/*.cts` other than `phase-id.cts`. It is wired to `npm run check:phase-id-drift` and asserted zero via a `scanRepo(ROOT)` integration test. A narrow allowlist keyed by an explicit `// phase-id-owner: <reason>` comment covers sanctioned exceptions (e.g. Cluster-1 / #2104 init sites, `// phase-id-owner: cluster-1-#2104`) until they migrate.

**Locked constraints on the guard's own implementation** (so it does not become new tech debt):
- It must be **behavioral**, not a `readFileSync(path).includes(...)` inside a `tests/**/*.test.cjs` file — that trips `eslint-rules/no-source-grep.cjs` (bound `local/no-source-grep`, `error` in tests). Text-scanning lives in the `scripts/` pure function; the test `require()`s it and calls it with **inline string literals**, per `tests/package-identity.test.cjs:22-25`.
- It must **not** be modeled on `tests/package-name-single-source.test.cjs`, which only *appears* to satisfy `no-source-grep` because the rule's taint-tracking loses the variable after `.split()` — an evasion, not an exemption.

*Rejected:* (B) an ESLint `no-restricted-syntax` rule — the repo has exactly one such rule (test-timing hygiene, `eslint.config.mjs:363`) and no single-ownership lint precedent; a `node:test` behavioral contract is the established, proven pattern. (C) outcome-parity only (run two paths, diff outputs, as `tests/phase.test.cjs:6881` `expectParity` does for #3537) — necessary but insufficient: it proves two paths *agree today*, not that only one *implementation* exists, so it cannot catch a third divergent site added tomorrow.

## Consequences

**Positive:**
- The recurring #2111/#2114-class bug is root-caused, not point-fixed: one seam owns the parsing, and the Phase-4 guard makes re-divergence a CI failure rather than a future issue number.
- #2114's `roadmap get-phase` / `ui-plan-gate` split is closed by delegation, and the two ROADMAP content matchers collapse to one resolver.
- The config-aware prefix API gives #2104 (and its siblings #1836, #2056) a single correct home the moment #2105 lands.
- Callers gain named, tested parsing functions in place of inline `\b…\b` cleverness that is hard to read and harder to debug (Kernighan's Law).

**Negative:**
- Touching `normalizePhaseName`'s neighborhood is high-risk (84 affected symbols). Decision 2 (extend-never-mutate) contains the risk but constrains the design — the fixes must be new functions, not tighter versions of the old ones.
- Four sequential PRs plus sub-issues is more process overhead than a single "fix the three bugs" PR — accepted, because a batched fix would re-seed the very divergence this epic removes and violates one-issue-one-PR.
- The Phase-4 guard adds an allowlist that must be curated as #2104/#2105 land; a stale allowlist entry is a small, visible debt rather than a silent gap.

**Neutral:**
- `phase-id.cts` grows from a normalizer into the full phase-ID surface; it stays pure (no Node built-ins), so the FS-touching resolver deliberately remains `getRoadmapPhaseInternal` in `roadmap-parser.cts`.
- `#2104` remains open and independently tracked; this epic neither closes nor blocks on it.

## Alternatives considered

1. **Point-fix each of the three bugs in place.** Rejected: leaves the seam absent, so surface #4 (init.cts, validate.cts) re-diverges under the next issue number — the exact history from #905 → #2111, #1455 → #2114, #2056 → #2104.
2. **One big PR consolidating everything at once.** Rejected: violates `CONTRIBUTING.md` "One issue = one … = one PR"; unreviewable across a CRITICAL-blast-radius symbol; no fail-first regression discipline per bug.
3. **Golden-regex lint (all sites must textually match one pattern).** Rejected: enforces textual sameness, not single ownership, and cannot express the semantic divergence (anchored vs unanchored vs `Phase`-anchored are all syntactically valid).
4. **Second module (`phase-resolver.cts`).** Rejected: a new seam alongside the existing `phase-id.cts` seam deepens, rather than removes, the divergence.

## Software laws applied

Cross-referenced via `/skills-from-the-artificer`; the laws that materially shaped the decisions:

- **Hyrum's Law** — `normalizePhaseName`'s 20 callers depend on its observable behavior ⇒ *extend, never mutate* (Decision 2).
- **Postel's Law** — the current parsers are too liberal (mine any numeral; strip any prefix) ⇒ tighten acceptance to the anchored / config-aware forms (Decisions 3–4).
- **Gall's Law** — `phase-id.cts` is a working simple system; grow it incrementally through a phased epic rather than a big-bang rewrite (Decisions 1, 6).
- **DRY / single-source-of-truth (Generative Fix Divergence)** — one seam, guarded, is the whole point (Decisions 1, 7).
- **Kernighan's Law** — inline `\b…\b` one-liners are hard to debug; naming + centralizing them lowers the debugging cost the bugs were paying (Decision 3).

## Cross-references

- Symptom issues: [#2111](https://github.com/open-gsd/gsd-core/issues/2111), [#2114](https://github.com/open-gsd/gsd-core/issues/2114), [#2104](https://github.com/open-gsd/gsd-core/issues/2104) (blocked on [#2105](https://github.com/open-gsd/gsd-core/issues/2105)/#2056).
- Prior art: #1455 (`OPTIONAL_PROJECT_CODE_PREFIX_SOURCE`, `roadmap-parser.cts`); `CLAUDE.md` → "Generative Fix Divergence"; `scripts/lint-package-identity-drift.cjs` + `tests/capability-precedence-parity.test.cjs` (the guard models).
- Owner seam: `src/phase-id.cts`. Impure resolver: `src/roadmap-parser.cts:getRoadmapPhaseInternal`.

## Amendments

*(none yet — append-only; amendments extend this ADR with a dated `### #<issue> — <topic>` section rather than rewriting the body above.)*

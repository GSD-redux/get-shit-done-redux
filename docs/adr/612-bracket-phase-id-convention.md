# ADR-612: Bracket Phase-ID Convention

- **Status:** Proposed (PR-0 — ADR only; locks the contract PR-1…PR-6 execute against. No production code lands in this PR.)
- **Date:** 2026-07-11
- **Issue:** [#612](https://github.com/open-gsd/gsd-core/issues/612) — epic (bracket phase-ID convention, `type: enhancement` + `approved-enhancement`)
- **Supersedes:** nothing (no prior ADR). The `milestone-prefixed` (M-NN) *convention* introduced by [#565](https://github.com/open-gsd/gsd-core/issues/565) is deprecated forward via the migrator — see Decision 5. This is a convention-direction call, not an ADR supersede.
- **Relationship to prior work:** completes [#39](https://github.com/open-gsd/gsd-core/issues/39) (milestone-encoding phase IDs), which #565 partially implemented as M-NN. Sibling of [ADR-2121](2121-phase-identifier-parsing-consolidation.md) ([#2121](https://github.com/open-gsd/gsd-core/issues/2121)) — the phase-identifier parsing consolidation that made `src/phase-id.cts` the single canonical owner of phase-token grammar; the bracket grammar lands **inside that owner** (Decision 4). The opt-in gating discipline mirrors ADR-1244's capability boundary without modeling bracket as a capability (Decision 9).

## Context

GSD phase identifiers encode up to **three numeric dimensions** — milestone, phase (with optional dotted sub-phase decomposition), and plan — across four surfaces: human display, on-disk directory names, `ROADMAP.md` headings, and plan/summary filenames. The same string is read by many subsystems (CLI args, migrator, validator, progress renderer, statusline) and, increasingly, by multiple coordinating LLM sessions across repositories — the motivating use case for #39 and #565.

### The hyphen is overloaded under M-NN

The `milestone-prefixed` (M-NN) convention encodes the milestone by **hyphen-joining it to the phase** (`2-01` = milestone 2, phase 01) and the plan by **another hyphen** (`…-01`). That is **two separator types (hyphen, dot) for three dimensions**, so the hyphen means *milestone↔phase* in one position and *phase↔plan* in another. Once a token carries both a dotted sub-phase and a plan, it has no deterministic parse (proven in Decision 3).

### The lineage, stated honestly

- **#39** proposed milestone-encoding phase IDs.
- **#565** implemented that as M-NN. This is a *partial* resolution: it lifts the milestone into the leading integer but leaves the hyphen overloaded, so the token becomes ambiguous once sub-phases and plans coexist.
- This ADR **completes #39's intent** with the bracket grammar, which lifts the milestone out of the phase token entirely.

**M-NN's current status is first-class, not vestigial.** Unlike the situation at the original #612 filing, M-NN is now a shipped, tested convention on `next` (v1.7.0-rc.5). Three distinct facts must be kept separate — conflating them is the trap:

1. **The default config value is `null`**, not M-NN — `gsd-core/bin/shared/config-defaults.manifest.json:14` sets `"phase_id_convention": null`. A fresh repo speaks no milestone convention.
2. **M-NN is a shipped, first-class convention** with live machinery: a deprecation-style migration nudge in `src/roadmap-parser.cts:430` (`getMilestonePhaseFilter`, warning body at `:441-445`) and the W021 read-path check in `src/verify.cts:1724` (`phase_id_convention === 'milestone-prefixed'` branch, warning at `:1733`). W021 is pinned by shipped `tests/milestone-prefixed-convention.test.cjs` and cannot be renumbered.
3. **M-NN is the default and only migrator target today** — `src/roadmap-command-router.cts:190` defaults `convention = 'milestone-prefixed'` and `:204` rejects any other `--convention` value; `src/roadmap-upgrade.cts:593` writes `phase_id_convention = 'milestone-prefixed'`.

The deprecation stance in Decision 5 is therefore a *forward-migration* call (consolidation), not the earlier "nobody adopted M-NN so it can be discarded" argument — that argument is dead.

## Decision

### 1. Adopt the bracket grammar

```
[GSD.02] 05.03-01
 │   │   │  │   └── plan       01   one hyphen — only ever the plan (filename surface only)
 │   │   │  └────── subphase   03   dot — optional decomposition
 │   │   └───────── phase      05   zero-padded integer
 │   └───────────── milestone  02   dot-joined INTO the bracket
 └───────────────── project    GSD  uppercase alpha [A-Z]{1,6}
```

Three dimensions, two separators, **zero reuse**: dots are always phase-levels, the single hyphen is always the plan, the milestone always lives in the bracket / dir-prefix.

| Surface | Form |
|---|---|
| Display | `[GSD.02] 05.03-01` |
| On-disk dir (Option B, no brackets) | `GSD.02-05.03-some-feature/` |
| Plan/Summary file | `05.03-01-PLAN.md` (milestone in dir prefix, **not** filename) |
| ROADMAP phase heading | `### [GSD.02] 05.03: Name` |
| ROADMAP milestone heading | `## [GSD.02] Foundation` (name, no number) |

**Milestone source (READING-B).** Under bracket, the milestone comes from the `[PROJECT.MM]` bracket / dir prefix, **never** from the phase-token leading integer. This is a deliberate departure from `getMilestoneFromPhaseId` (`src/phase-id.cts:91`), which today reads the leading integer (READING-A: `stripped.match(/^0*(\d+)-\d/)` → `v{major}.0`). READING-A is correct for M-NN and stays intact for it; READING-B is added only on the bracket path (Decision 6).

**Heading discriminator.** A phase heading is a bracket followed by a digit-then-colon (`[GSD.02] 05:`); a milestone heading is a bracket followed by a name (`[GSD.02] Foundation`). A milestone name that begins with a digit is disambiguated by the trailing colon (phase numbers carry it; names do not). The current parser already tolerates a `[…]` prefix before `Phase` (`src/roadmap-parser.cts` heading regexes carry `(?:\[[^\]]{1,200}\]\s*)?`), which is the porting anchor for PR-2.

### 2. Opt-in gating — legacy paths byte-untouched

Every bracket emit / display / milestone-detection path is gated on `config.phase_id_convention === 'bracket'`, and **never** on `project_code` presence (a repo can carry a `project_code` without opting into bracket — gating on `project_code` presence is a latent-bug class caught while prototyping this series). The `null` (un-migrated) and `'milestone-prefixed'` (M-NN) parse/emit paths are **byte-identical to today**. Reads remain tolerant of all forms during the migration window; read-tolerance is not a second active convention.

### 3. The plan dimension and the concrete collision (PR-0 anchor)

The plan is the third dimension. In bracket form it is a single trailing hyphen + zero-padded integer that appears **only in filenames** (`05.03-01-PLAN.md`); the milestone never shares that hyphen because it lives in the bracket. Under M-NN the same hyphen carries both *milestone↔phase* and *phase↔plan*, which is the defect.

**The empirical anchor**, grounded in the two live regexes of `normalizePhaseName` (`src/phase-id.cts:66`):

- Anchored milestone regex, `src/phase-id.cts:71`: `/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i`. On `2-01.02-01` it captures `2`, then `-01`, then `.02` — but the trailing `-01` (the plan) cannot be consumed by the dot-only sub-phase tail `(?:\.\d+)*`, so the `$` anchor fails and the match is rejected.
- Unanchored numeric fallback, `src/phase-id.cts:79`: `/^(\d+)([A-Z])?((?:\.\d+)*)/i`. With no `$`, it matches only the leading `2` and zero-pads it. Everything after the leading integer is silently dropped.

Result (empirically confirmed against `gsd-core/bin/lib/phase-id.cjs`):

```js
normalizePhaseName('2-01.02-01') === '02'   // milestone 2, phase 01, subphase 02, plan 01  →  collapses to bare "02"
normalizePhaseName('10-02.03-04') === '10'  // same failure class — trailing plan hyphen after ".03" kills the anchor
```

A fully-specified `(milestone, phase, subphase, plan)` identity silently collapses to a bare two-digit integer that is indistinguishable from a bare phase. This is the "prove the defect first" artifact the #612 approval requires; it is locked as a **green characterization test** in `tests/adr-612-collision-characterization.test.cjs` (see Decision 3's note on green-ness).

The boundary of the defect is instructive — the collapse appears **only** when all four dimensions coexist:

```js
normalizePhaseName('2-01')      === '02-01'      // milestone + phase — anchor matches, no collapse
normalizePhaseName('2-01.02')   === '02-01.02'   // + subphase (dot) — anchor still matches
normalizePhaseName('2-01.02-01') === '02'        // + plan (hyphen after dot) — anchor fails, collapse
```

**A second, cross-subsystem ambiguity** (semantic, not a parse collapse): the token `02-04` is a *valid* production in two subsystems with two meanings. `normalizePhaseName('02-04') === '02-04'` reads it as milestone 02 / phase 04 (`src/phase-id.cts:71` matches — no collapse). The **same string** is the phase-02 / plan-04 token in plan-file notation (`{padded_phase}-{NN}-PLAN.md`, per `gsd-core/references/universal-anti-patterns.md` and `--plan NN-MM` in `docs/COMMANDS.md`). The token alone cannot tell a resolver which subsystem is asking. This is a genuine defect but a *different class* than the collapse above — it is characterized (asserting the non-collapsing current output) but is not the primary anchor.

**The bracket contrast (target contract, expected-fail until PR-1 — prose only, NOT in the PR-0 test):** once the grammar lands, `parsePhaseId('GSD.02-05.03-01')` yields exactly one tuple `{ project:'GSD', milestone:'02', phase:'05', subphase:'03', plan:'01' }`, and `renderPhaseId` / `toDir` round-trip it. `parsePhaseId` does not exist on `next`, so this contract is documented here as the PR-1 acceptance target and deliberately **excluded** from the PR-0 test, which is green-only and asserts current behavior exclusively.

### 4. EMIT/RENDER as one pure function pair with round-trip property tests

PR-1 introduces one pure model — a single `parsePhaseId` plus two renders sharing one `PhaseId` shape — added **inside `src/phase-id.cts`**, the single canonical owner established by ADR-2121:

```ts
type PhaseId = {
  project: string;     // 'GSD'
  milestone: string;   // '02'  (zero-padded; from bracket/dir prefix — READING-B)
  phase: string;       // '05'  (zero-padded)
  subphase?: string;   // '03'  (optional)
  plan?: string;       // '01'  (filename surface only)
};

function parsePhaseId(input: string): PhaseId;       // accepts display OR dir OR bare arg
function renderPhaseId(id: PhaseId): string;         // '[GSD.02] 05.03-01'
function toDir(id: PhaseId, slug: string): string;   // 'GSD.02-05.03-slug'
```

The pair is verified with **`fast-check` property tests** (`fast-check ^4.8.0` is an installed devDependency on this base — `package.json:66` — and `tests/phase-id.test.cjs` already imports it), holding the bijective contract the maintainer requires:

- `render(parse(x)) === x` for every well-formed display string `x`;
- `toDir(parse(display), slug) === dir` for every display/dir pair.

Because the grammar lands in `phase-id.cts`, it inherits the #2128 single-owner regime: the canonical token source `PHASE_NUMBER_TOKEN_SOURCE` (`src/phase-id.cts:44-54`) and the anti-divergence guard `scripts/lint-phase-id-drift.cjs` (ADR-2121 Decision 7). **Design constraint for PR-1:** the bracket grammar must be an owner-sanctioned extension inside `phase-id.cts` — any new phase-token regex literal it introduces elsewhere requires a `// phase-id-owner: <reason>` sanction, or `check:phase-id-drift` fails CI. It must never be re-derived in another module. This strengthens, rather than replaces, the centralization the maintainer already enforces.

All existing consumers (`phase.cts`, `roadmap.cts`, `roadmap-parser.cts`, `validate.cts`, `verify.cts`, `commands.cts`) call this pair rather than re-implementing regexes inline.

### 5. M-NN deprecation is terminal — end state is two conventions, by consolidation

Bracket is the **terminal** convention. The end state is **two conventions — `null` and `bracket`** — down from the transient three (`null`, `milestone-prefixed`, `bracket`). This is achieved by **consolidation, not addition**: M-NN is deprecated *forward* through the migrator, not removed out from under any adopter.

- Going forward the runtime speaks one milestone convention: `bracket` (gated on `phase_id_convention: 'bracket'`). `null` remains permanently supported for un-migrated / non-milestone repos.
- M-NN parse/emit is retained as **migration-window read-tolerance and as a migrator source** — it is not a second active *emit* convention.
- The deprecation is grounded in machinery that already exists: the `getMilestonePhaseFilter` nudge (`src/roadmap-parser.cts:441-445`) and the W021 hint (`src/verify.cts:1733`) already tell M-NN repos to run the migrator. The bracket migrator (Decision 7) extends that forward path to carry M-NN → bracket.
- Which release carries the cutover is the maintainer's call — release mechanics, not design. No stale rc is named here.

This is the design hinge the maintainer flagged; it is **decided here**, not deferred.

### 6. Milestone-detection rewrite behind the opt-in flag; legacy intact

`getMilestoneFromPhaseId` (`src/phase-id.cts:91`, single-arg, READING-A today) gains a bracket path that derives the milestone from the `{CODE}.{MM}-` prefix (READING-B), gated on `phase_id_convention === 'bracket'`. The `null` and `'milestone-prefixed'` paths keep the current READING-A body **byte-untouched**. Gating requires either a new parameter or a config read at the call boundary — that is a PR-1 design choice, not decided here. Discriminator test (PR-1): `getMilestoneFromPhaseId('GSD.02-05.03')` resolves to milestone 2, not milestone 5. Sentinel behavior (`0.x` / `999.x` → milestone `null`) is preserved (`src/phase-id.cts:96`).

The convention value is validated by a new enum `VALID_PHASE_ID_CONVENTIONS` in `src/config.cts`. Today the value is an un-validated magic literal — `config.cts` has per-key enum blocks for other keys but none for `phase_id_convention`. The enum lands in the display/config PR (PR-4/PR-5).

### 7. Migrator commitments

The bracket migrator (`src/roadmap-upgrade.cts`) preserves the existing safety triad and extends the source grammar:

- **Dry-run by default** — `applyMigration` (`src/roadmap-upgrade.cts:478`) sets `const dryRun = options.dryRun !== false` and prints the full plan without mutating (`:485-487`).
- **Dirty-tree guard** — a non-empty `git status --porcelain` throws before any write (`:497-498`).
- **Atomic rollback on failure.** *The #612 approval names this "HEAD-sha rollback."* On this base the mechanism is intentionally different and stronger: a **surgical, git-independent reverse-rename + per-file snapshot** (`#1542`, `src/roadmap-upgrade.cts:509-524` and the rollback block `:598-616`). A `git reset --hard` + `git clean` restores **nothing** for a gitignored `.planning/` (`commit_docs:false`, the default) and is a whole-repo operation besides; the surgical rollback reverses exactly the renames performed and restores exactly the files snapshotted, correct whether `.planning/` is tracked or ignored. **The requirement's intent — atomic, safe rollback on failure — is met; PR-3 preserves this safer mechanism rather than regressing to a HEAD-sha reset.** This is a deliberate deviation from the requirement's literal wording, surfaced here for the maintainer.
- **Real-world dir-layout fixture corpus** with two named invariants (both are failure classes confirmed against real repository layouts while prototyping the migrator):
  1. **Decimal multi-milestone directories keep distinct per-milestone prefixes** — a tree with ≥2 milestones in dotted form must not flatten distinct milestones into one phase counter.
  2. **Project-prefixed single-milestone directories don't no-op** — a single-milestone legacy tree (`HQ-01`, `HQ-02`…) must derive its milestone (`01`) from `## vN.M` / STATE.md and emit bracket dirs, not exit "already migrated."
- **M-NN → bracket lift preserves the milestone integer** — `2-01` → `01`, `2-04-01` → `04.01`.
- **HARD-REFUSE when `project_code` is absent** — bracket requires a project code; the migrator refuses (throws) rather than emitting a malformed prefix.

### 8. Single-sourced, generated injection block with a verify parity check (PR-6)

The convention block injected into agent and workflow definitions is **generated from one canonical source**, and a verify check enforces parity between the source and every injected copy. This keeps the injection **machine-uniform** across the surfaces the #612 approval scopes — **~34 agent definitions, ~90 workflow files, and 7 phase templates** — so PR-6 cannot be reviewed line-by-line and does not silently drift. (On this base the surface counts are: `agents/*.md` = 34; `gsd-core/workflows/**/*.md` = 114 — 91 top-level command workflows (the `~90` the approval scopes) plus 23 nested mode/step/template fragments under `discuss-phase/` (11), `execute-phase/` (5), `help/` (4), and `plan-phase/` (3); the "7 templates" figure is the approval's stated parity scope, corresponding to the phase-emitting subset of `gsd-core/templates/`, e.g. `phase-prompt.md`, `roadmap.md`, `state.md`, `planner-subagent-prompt.md`, `summary.md`. The generator, not this ADR, pins the exact set.) There is no existing block-injection pattern in the repo — PR-6 builds it net-new, with the parity check as the acceptance gate.

### 9. Guardrail — bracket is not a capability

The repo has a capability ecosystem (ADR-1244, ADR-1016, ADR-1143, ADR-1213). Capabilities are **add-only descriptors**; a capability cannot deprecate M-NN. Bracket is therefore **core config-gated behavior, not a capability descriptor.** Keep three levels unblurred:

1. **Capability model** = add-only → bracket is not a capability (this guardrail).
2. **Implementation** = additive, gated, legacy byte-untouched (Decision 2) — the *code* is additive.
3. **Convention direction** = M-NN terminal, end state two (Decision 5) — the *convention* consolidates.

"Additive implementation" must not contaminate the deprecation stance: the code is additive; the convention consolidates.

## Phases

Each phase is an independently-green PR. Tolerant reads (PR-2) ship before emit (PR-4), so a partially-landed series never breaks legacy repos. Module homes are the current `src/*.cts` names (post-ADR-857 / #1267; `core.cts` no longer exists).

| PR | Scope | Primary modules |
|---|---|---|
| **PR-0** | This ADR + plan-dimension spec + concrete collision characterization test. No behavior change. | `docs/adr/612-*.md`, `tests/adr-612-collision-characterization.test.cjs` |
| **PR-1** | Core grammar: `PhaseId` type, `parsePhaseId`/`renderPhaseId`/`toDir` with fast-check round-trip properties, READING-B `getMilestoneFromPhaseId` (gated), bracket `extractPhaseToken` branch, comparator, sentinel + slug guards — all inside the single-owner leaf. | `phase-id.cts` |
| **PR-2** | Read path: bracket heading/dir/checklist tolerance + bracket-coherence checks. | `roadmap.cts`, `roadmap-parser.cts`, `validate.cts`, `verify.cts` |
| **PR-3** | Migrator: legacy + M-NN → bracket; dry-run / dirty-guard / surgical rollback preserved; HARD-REFUSE on absent `project_code`; real-layout fixture corpus (two invariants). | `roadmap-upgrade.cts`, `roadmap-command-router.cts` |
| **PR-4** | Write path: bracket emit gated on convention; new-project default; STATE.md `milestone:` frontmatter; `VALID_PHASE_ID_CONVENTIONS` enum. | `phase.cts`, `state.cts`, `config.cts` |
| **PR-5** | Display + card: progress render + stats `display_id` route through the pure pair; statusline; convention card single-source. | `commands.cts`, `hooks/gsd-statusline.js` |
| **PR-6** | Generated injection: single-sourced convention block across agents / phase-emitting workflows / templates + verify parity check; canonical reference doc; grep-evidence gate. | `gsd-core/references/`, `agents/*.md`, `gsd-core/workflows/**/*.md`, `gsd-core/templates/` |

## Consequences

- **Positive:** every token is uniquely parseable; one pure round-trippable model under the single-owner regime; milestone-detection correct under READING-B; legacy (`null` / M-NN) repos byte-untouched; migration is opt-in and reversible; the convention count drops from a transient three to a terminal two.
- **Negative:** a migration window in which reads must tolerate three forms; a second milestone authority under bracket (bracket integer vs STATE.md `milestone:`) whose coherence-check teeth are advisory (W021, message-disambiguated per the folded W021 disposition below); the `getMilestoneFromPhaseId` return-form under bracket is ratified as `vN.0` (Decision 3 below), with the archive-dir glob coupled to that form.

## Decisions to ratify

Resolved items are folded into the body above. These remain open and gate their named PR:

1. **Bare `02-04` resolution** (gates PR-1 `normalizePhaseName` / PR-2 resolvers). Options: (i) throw a disambiguation error; (ii) keep the current M-NN reading and let only the bracket path reject it; (iii) a `surface: 'phase' | 'plan'` context hint. The throw is a *new* behavior — `normalizePhaseName('02-04')` returns `'02-04'` today, it does not truncate — so it is not merely a fix. Not committed here.
2. **`phase_naming` vs `phase_id_convention` axis relationship** (gates PR-4 build-default). Confirm these are two independent axes before wiring the new-project `'bracket'` default; the build-default object sets `phase_naming` but omits `phase_id_convention`.
3. **`getMilestoneFromPhaseId` return-form under bracket + archive-dir naming** (gated PR-1/PR-2) — **RATIFIED 2026-07-24: `vN.0`** (STATE.md parity, lowest churn), chosen over a bare integer; the archive-dir glob is value-coupled to this form and follows `vN.0`. PR-1 (#2258) ships this return-form. The separate milestone-identity normalization arc is unaffected.
4. **Convention-card single-source location** (gates PR-5/PR-6). Pin the single module/path so the ASCII grammar card renders identically at installer completion, migrator start (dry-run and apply), and in docs.

**Folded (resolved):** M-NN deprecation stance → terminal by consolidation (Decision 5). W021 renumber → **void**: W021 is pinned by `tests/milestone-prefixed-convention.test.cjs` and is kept, message-disambiguated (the earlier plan to renumber it is dropped). READING-B milestone source → Decision 6.

## References

- Issue [#612](https://github.com/open-gsd/gsd-core/issues/612) (this epic) — `approved-enhancement`, tracer-bullet sequence PR-0…PR-6.
- Issue [#39](https://github.com/open-gsd/gsd-core/issues/39) (milestone-encoding origin), [#565](https://github.com/open-gsd/gsd-core/issues/565) (M-NN implementation).
- [ADR-2121](2121-phase-identifier-parsing-consolidation.md) ([#2121](https://github.com/open-gsd/gsd-core/issues/2121)) — phase-identifier parsing consolidation; single canonical owner `src/phase-id.cts`; anti-divergence guard. #2128 is the `PHASE_NUMBER_TOKEN_SOURCE` constant (`src/phase-id.cts:44-54`).
- [ADR-1244](1244-capability-ecosystem.md), [ADR-1016](1016-runtime-capability-descriptor.md) — capability model (guardrail, Decision 9).

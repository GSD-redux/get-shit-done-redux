# ADR-1671: Dynamic context management platform

- **Status:** Proposed
- **Date:** 2026-06-24
- **Extends:** ADR-0002 (Command Contract Validation Module), ADR-457 (build-at-publish generation model for `bin/lib/*.cjs`)
- **Relates:** ADR-857 §7 (Connected-Capability / MCP contract — kept deferred by this ADR)

## Context

GSD ships command and workflow content as large, hand-edited Markdown files. Two structural problems compound:

1. **Authoring is monolithic.** A single workflow body carries every branch inline. `gsd-core/workflows/plan-phase.md` is 93,973 bytes / 1,770 lines; `execute-phase.md` is 93,426 bytes. Mutually-exclusive paths (`--prd`, `--ingest`, `--mvp`, `--reviews`) all live in the same file, so a runtime loads guidance for branches a given invocation will never take.

2. **One payload ships to every runtime.** Install copies the whole `gsd-core/` tree (3.4 MB, 89 workflows, 1.7 MB) **byte-identical to all 15 runtimes** via `copyWithPathReplacement` (`bin/install.js`). The only per-runtime work is string rewrites and description truncation. There is **no per-runtime trimming or splitting**.

The result is constant pressure against size caps, enforced today only against *source* files (not emitted output) by a two-part guard (issue #1074): a per-file baseline ratchet plus per-tier hard caps (workflows XL 96 KiB / LARGE 60 KiB / DEFAULT 40 KiB; agents XL 56 KiB / LARGE 48 KiB / DEFAULT 24 KiB). Several files have almost no headroom — `agents/gsd-verifier.md` has **293 bytes**. The one true emission-time cap, Windsurf's 12,000-byte limit (`src/runtime-artifact-conversion.cts`), is a hard `throw` with no graceful fallback. Adding one rule to a tight file forces an extract-to-`references/` refactor (`DEFECT.AGENT-FILE-SIZE-CAP-BREACH`), turning a one-line edit into a multi-file change that ripples across stub frontmatter, the workflow body, reference fragments, and `docs/` — each guarded by a different lint.

A separate but related pain: the repo-root `CONTEXT.md` predicate fact-store (~935 lines, ~200 KB of `CLASS.subkey=value` predicates that agent briefs are required to "cite verbatim") has **no programmatic reader, validator, or selector**. Briefs are hand-assembled, and `META.RULE.brief-must-cite-doc` is enforced only socially — paraphrasing from memory has caused real violations (5/8 agents in one documented batch).

### The machinery already exists, in silos

Research into the codebase found that most JIT primitives are already present and proven; they are just single-purpose and not composed:

- **Lazy reference loading** — the init bundle. `gsd_run query init.<cmd>` (`src/init.cts`) returns JSON of *paths + flags, not contents*; the model reads only the files it needs ("paths only to minimize orchestrator context", `plan-phase.md:66`). This is Anthropic's recommended "lightweight identifiers over payloads" pattern, in production.
- **Progressive disclosure** — `gsd-core/workflows/help.md` reads only the one mode file matching the argument (`brief` 0.9 KB / `default` 1.9 KB / `full` 34 KB).
- **Token-budgeted assembly** — `src/prompt-budget.cts` `applyBudget()` already does priority-ordered, budget-trimmed composition with an omission note — but it is walled into the cross-AI review pipeline only.
- **Pointer-passing channel** — `src/io.cts` spills any payload > 50 KB to a tmpfile and returns `@file:<path>`.
- **A codegen factory + drift-guard harness** — 13 generators share one `--check`/`--write` idiom (derive fresh, diff committed, exit 1 on drift). `scripts/gen-plugin-skills.cjs` already generates 69 shipped `SKILL.md` files from `commands/gsd/*.md`.
- **A reusable structured-markdown parser** — `src/markdown-sectionizer.cts`, already powering the per-phase `<decisions>` fact-store reader (`src/decisions.cts`).

### External practice

The closest external analogs are Anthropic Agent Skills' three-tier progressive disclosure (metadata → `SKILL.md` → bundled references), MCP resources/prompts/deferred-tools (list-then-fetch JIT), and priority/token-budget prompt renderers (Priompt, VS Code `@vscode/prompt-tsx`) that include the highest-priority fragments that fit a budget via a binary-search cutoff, with `flexReserve` floors for load-bearing content and `<isolate>` for a stable cacheable prefix. The portability catch is real and load-bearing: only the Skills *format* (directory + `SKILL.md` + frontmatter) is an open standard; native lazy loading is Claude-specific, and GSD's 15 runtimes do not all support skills or MCP (cf. surface-mismatch bugs #1614 antigravity, #1615 windsurf).

## Decision

Adopt a **dynamic context management platform** built on a hybrid of build-time and run-time assembly, reusing the existing seams rather than inventing new infrastructure:

1. **Fragment store (authoring model).** Author workflow content as composable, priority-tagged fragments (workflow sections + shared `references/` + predicate-derived blocks), each carrying an applicability condition (which flags / capabilities / runtimes require it). This is the net-new authoring discipline.

2. **Build-time composer + per-runtime budget emission (the universal floor).** Generalize `prompt-budget.cts` out of the review silo into a shared `context-composer` seam (`src/*.cts` → `build:lib` → `bin/lib/*.cjs`). At build/install time, for each command × runtime, the composer selects the needed fragments and trims by priority to fit that runtime's measured cap (`scripts/workflow-size.cjs` `lfByteCount`), emitting a right-sized artifact through the existing converter. Caps move from *source* to *emitted output*; the Windsurf 12 KB `throw` becomes a graceful auto-trim/auto-extract — noting that this `throw` is currently **duplicated byte-identically in two surfaces**, `bin/install.js:2796-2797` and `src/runtime-artifact-conversion.cts:1116-1117`, so the change must land in both or they drift. This is what makes caps stop biting on non-lazy runtimes, and it requires no runtime feature — so it is the universal floor.

3. **Progressive disclosure where the host supports it.** On lazy-loading hosts (Claude Code and the Agent SDK), keep the stub + `@-ref` model and let the init bundle name exactly which files to read; the body and references load on demand.

4. **Run-time selection via the init seam (per-request precision).** Extend the init bundle / `command-routing-hub` dispatch (`src/command-routing-hub.cts`) to emit a typed manifest of which sections / references / predicates a *specific* invocation needs (given parsed args, flags, phase state, active capabilities), reusing the `@file:` spill channel for assembled fragments. This is layered on top of the fragment store.

5. **Formalize the `CONTEXT.md` predicate fact-store → JIT selector.** Give the predicate grammar a parser (on `markdown-sectionizer`), an ID-uniqueness validator, a `--check`/`--write` drift-guard, and a `task → relevant predicate set` selector. This converts hand-assembled briefs into JIT-generated context and attacks the maintainer-side "edit a 200 KB file by hand" pain directly. **This is sequenced first** (see Prototype) because it is the smallest, lowest-risk piece that proves the whole pattern.

6. **Defer MCP (Connected-Capability).** Per ADR-857 §7 / #956, a served MCP catalog (resources/prompts/deferred-tools) remains an additive future enhancement for MCP-capable runtimes — never a replacement for the file-copy floor. Not in scope here.

### Options considered

| Option | Summary | Fixes caps? | Runtime compat | Decision |
|---|---|---|---|---|
| A. Progressive-disclosure authoring | Metadata-first files + one-level references; lean on host lazy-load | Partial; needs host lazy-load | Authoring universal; native JIT Claude-first | Adopt as a layer |
| B. Build-time composer + per-runtime budget emission | Composer trims fragments to each runtime cap, emits right-sized files | Yes — measured before write | Universal floor | **Adopt as core** |
| C. Run-time selection via init seam | Init bundle names which slices this invocation needs | Reduces per-invocation context | Broad (the `gsd_run` shim is universal) | Adopt after B |
| D. MCP served catalog | Serve content as resources/prompts/deferred-tools | For MCP hosts only | Partial; needs 2nd channel | Defer (ADR-857 §7) |
| E. Predicate fact-store → JIT selector | Parse/validate/select `CONTEXT.md` predicates | Maintainer-side big-file pain | N/A (build + orchestrator) | **Adopt first** |

Pure Agent Skills (A alone) and pure MCP (D alone) were rejected as the foundation because both are runtime-partial; only build-time emission (B) relieves caps on every runtime.

## Architecture and contracts

- **Fragment unit (open question, see below):** either separate files (clean lazy-load + INVENTORY rows) or in-file section markers (`<!-- gsd:section ... -->`, mirroring the existing `<!-- gsd:loop-host -->` markers consumed by `scripts/gen-loop-host-contract.cjs`).
- **Composer contract:** an ordered list of fragments, each carrying a *shrink strategy*; the closed set is `verbatim`, `head-shrink`, `proportional-truncate` (with a per-fragment floor), and `drop`. `flexReserve`-style floors for load-bearing fragments (`META.RULE` citation rules, contribution gates, closing-keyword rules) generalize the existing per-plan 1024-byte floor. A byte-stable canonical prefix (`<isolate>`) is kept identical across runtimes to preserve KV-cache warmth and keep launcher-parity tests green.

  **Amended by #2929 (Phase 2).** This ADR originally specified the contract as "priority + binary-search cutoff to a per-runtime budget". Implementing Phase 2 established that a cutoff alone **cannot express the function this platform generalizes**: `prompt-budget.applyBudget` is not a cutoff but a fixed five-step ladder in which each section carries its own shrink strategy, and only three of its eight sections are ever droppable — `PROJECT.md` is head-shrunk to N lines and plans are proportionally tail-truncated with a per-plan floor, while instructions and roadmap are never trimmed at all. A cutoff composer sorts by priority and discards the tail; it has no way to say "shrink this one", "truncate that one but never below its floor", or "these three are the only droppables, in this order". Building to the literal wording and routing `prompt-budget` through it would have silently changed review-prompt output. Shrink strategies are therefore the core abstraction, and **binary-search cutoff becomes one strategy among them** — the right one for per-runtime emission in Phases 3-4, not for this ladder. Ordering is declaration order rather than a numeric priority field. This is an elaboration of the decision's intent, not a reversal of it.
- **Applicability grammar (added by #2930, Phase 3).** The fragment unit's `when=` attribute is deliberately a CLOSED grammar: exactly one atom from a frozen vocabulary — `always`, `flag:--wave`, `state:gap-closure-phase`, `state:has-prior-phases` — with no boolean operators, negation, or nesting, and an unknown `when=` value throws rather than being ignored. This is a Greenspun's-Tenth-Rule guard: left open-ended, `when=` acquires `&&`/`!`/precedence/runtime-capability predicates and becomes an ad-hoc, informally-specified predicate language grown one condition at a time. Widening the vocabulary requires a coordinated ADR amendment, not an organic edit. `when=` is parsed and validated in Phase 3 but not yet acted on; applicability selection is Phase 5.

  **Amended by #2992 (Phase 6.1) — the vocabulary widens 4 → 14, and the guard is restated.**
  This is the coordinated amendment this bullet requires; it is not an organic edit. Rolling the
  fragment model past `execute-phase.md` was impossible without it: three of the original four
  atoms are execute-phase-specific, so every other LARGE/XL workflow branches on conditions the
  vocabulary could not express.

  *The guard is composition, not cardinality.* This bullet's own rationale names the hazard
  precisely — `when=` acquiring `&&`/`!`/precedence and becoming an ad-hoc predicate language. A
  14-entry list with no operators is not a language; a 4-entry list **with** `&&` would be. Adding
  atoms therefore does not weaken the guard, and the following invariants are unchanged and
  binding: exactly one atom per marker, no boolean operators, no negation, no nesting, and an
  unrecognized `when=` still throws rather than being silently excluded. `WHEN_PREDICATES` remains
  a **hand-written literal map** — deriving a predicate from its atom string (`atom.slice(5)`) is
  tokenization, and a parser relocated into a build loop is still a parser. The redundancy between
  an atom's name and its literal token is deliberate; a behavioral test derived from the vocabulary
  catches a desync, because a desync silently excludes a section rather than failing loudly.

  *Two independent gates govern admission.* An atom ships only when it has **both** (1) a named
  consuming section of at least 400 bytes, established by survey, and (2) a fact the init seam
  demonstrably computes at a real entry point. Gate (2) was learned during implementation and is
  the more important of the two: an atom whose fact is never computed evaluates `false` forever, so
  a section marked with it is silently never included — strictly worse than not shipping the atom,
  because the marker looks like working gating. The same failure mode appeared twice more during
  this phase and is recorded so it is not rediscovered: `parseNamedArgs` always materializes a
  boolean flag key (`false` when absent, never `undefined`), so "present in the options record" is
  **not** token presence; and four workflow handlers passed no options at all. Both were fixed by
  wiring, not by relaxing the gate.

  **Shipped (14).** `always`, `flag:--wave`, `state:gap-closure-phase`, `state:has-prior-phases`
  (pre-existing), plus `flag:--auto`, `flag:--discuss`, `flag:--forensic`, `flag:--full`,
  `flag:--research`, `flag:--reset-phase-numbers`, `flag:--validate`, `state:needs-codebase-map`,
  `state:phase-mvp-mode`, `state:worktrees-enabled`.

  **Withheld (6), surveyed and justified but not yet computable.** `flag:--verify-only` and
  `state:is-monorepo` (docs-update), `flag:--converge` (autonomous), `flag:--fix` and
  `state:fallow-enabled` (code-review), `state:git-create-tag` (complete-milestone). Each fails
  gate (2): `docs-update` initializes through `cmdDocsInit` in `docs.cts`, and the other three run
  through the shared generic `init.phase-op` / `init.milestone-op` / `init.manager` entry points,
  each invoked by 20+ workflows — binding a workflow name into those would misattribute one
  workflow's sections to every other caller. They land with the entry-point work in the LARGE/XL
  rollout phase. The survey is recorded so it is not repeated.

  **Permanently ineligible condition classes** (found by survey, not admissible as atoms at any
  future point without a different mechanism): runtime tool/capability availability (Task tool,
  Playwright-MCP session), live git repository state, Capability-Registry/hook-resolved conditions,
  interactive answers given mid-run, and UAT/verification runtime results. None is knowable from
  parsed CLI arguments or `.planning/` state at init time.

  **Amended by #2993 (Phase 6.2) — the vocabulary widens 14 → 19, second
  coordinated amendment.** Rolling the fragment model onto `plan-phase.md` —
  the largest workflow in the repo — surfaced 5 more atoms, gated by the same
  two admission tests #2992 established: a named consuming section of at
  least 400 bytes, and a fact the init seam demonstrably computes. **Shipped
  (5).** `flag:--ingest`, `flag:--prd`, `flag:--research-phase`,
  `flag:--reviews` (each a direct `parseNamedArgs` addition to the
  `plan-phase` router handler; the generic flags-Set builder in `init.cts`
  picks them up automatically), and `state:chunked-mode`.

  `state:chunked-mode` is the one atom in this batch that is not a bare flag
  check: `plan-phase.md`'s `CHUNKED_MODE` is true when EITHER `--chunked` is
  passed OR `.planning/config.json`'s `workflow.plan_chunked` is set — a
  disjunction of a flag and a config read. That disjunction is resolved to a
  single boolean **in the fact**, computed once by the init seam
  (`buildSectionManifestField` in `src/init.cts`) before `selectSections` is
  ever called; `WHEN_PREDICATES['state:chunked-mode']` reads only
  `facts.chunkedMode` and contains no `||`. The `when=` grammar therefore
  still sees exactly one atom with no operator — the same invariant #2992
  restated is unchanged by this amendment. This generalizes to a rule for
  every future atom: **any condition that cannot be reduced to a single
  boolean fact is not an atom** — it is either resolved upstream in fact
  computation (as here) or it is not eligible for the grammar at all, per
  the "Rejected" cases (`--auto`/`--chain`/persisted-config interleaving;
  negated `--skip-bounce` OR `--gaps` OR NOT(...)) recorded in
  `.gsd/phase/chore-2993-fragmentize-plan-phase/40-design.md`.

  **Amended by #2994 (Phase 6.3) — the vocabulary widens 19 → 29, third coordinated
  amendment.** Rolling the fragment model onto the remaining 13 LARGE/XL workflows
  surfaced 10 more atoms, admitted under the same two gates #2992 established. This
  amendment is recorded retroactively by #2995 (Phase 6.4): #2994 shipped the atoms
  without it, which this bullet's own rule forbids ("Widening the vocabulary requires a
  coordinated ADR amendment, not an organic edit"). The gap was found by re-running
  `/adr-phase-coverage` against what actually merged. The atoms each satisfy both
  admission gates and are not in question; the missing record is.

  **Shipped (10).** `flag:--fix`, `state:auto-advance-active`, `state:fallow-enabled`,
  `state:flat-mode`, `state:git-create-tag`, `state:is-monorepo`, `state:next-channel`,
  `state:plan-strategy-converge`, `state:reviewer-instances-configured`,
  `state:ui-phase-active`, `state:workstream-active`. Compound real-world triggers
  (`--converge OR --cross-ai`, `--next OR --rc`, `--auto OR` config, `--discuss OR
  --full`) are each resolved to a single boolean in `src/init.cts` before evaluation, so
  `when=` still sees one operator-free atom — the `state:chunked-mode` precedent above.
  `state:flat-mode` is the positively-phrased inverse of `state:workstream-active`,
  because negation is not in the grammar.

  **`flag:--verify-only` is permanently REJECTED, not pending.** #2992 listed it among
  six withheld atoms and deferred all six to "the LARGE/XL rollout phase". Five shipped
  in #2994. `flag:--verify-only` did not, and will not: `docs-update`'s control flow is
  interleaved across three non-contiguous touch-points, so gating one would leave the
  other two as raw `$ARGUMENTS` checks. An atom with no genuine consuming section is dead
  vocabulary — the rot the frozen list exists to prevent. That disposition was recorded
  only in merged PR #3030's body, leaving this ADR still asserting a hand-off that will
  never complete; it is recorded here so the withheld list reaches a terminal state.

  **Amended by #2995 (Phase 6.4) — the grammar does NOT extend to `agents/`.**
  Migration step 7 names agents alongside workflows. Emission does extend: agent bodies
  now pass through `composeWorkflow` on every emission path, so a marker in an agent is
  stripped rather than shipped verbatim. **Gating does not.** `when=` selection is
  consumed from the committed `gsd-core/workflows/section-manifest.json`, which
  `scripts/gen-section-manifest.cjs` derives from `gsd-core/workflows/*.md` only; its
  shape is `{workflows: {...}}` and there is no per-agent entry, no per-agent init entry
  point, and no consumer that could evaluate an agent's `when=`. An agent atom therefore
  fails admission gate (2) — "a fact the init seam demonstrably computes at a real entry
  point" — and would be the exact silent-inertness failure that gate exists to prevent: a
  marker that looks like working gating while evaluating `false` forever. Agents are
  consequently size-managed by extraction to `gsd-core/references/` (the documented
  `DEFECT.AGENT-FILE-SIZE-CAP-BREACH` fix-forward), not by `when=` markers. Extending
  gating to agents would require a per-agent manifest family and a dispatch-time seam to
  read it; that is a separate decision, not an organic edit, and is not taken here.

  **Amended by #3065 (Phase 7) — the promised contract gate is built, and three records are
  corrected.** A post-merge audit of every promise in this ADR against the merged tree found one
  mitigation asserted-but-absent and two stale records.

  *The load-bearing contract gate now exists.* The Consequences section below claims, as amended by
  #2931, that a deterministic gate proves no load-bearing fragment was omitted or shrunk. Until this
  phase only synthetic unit tests of the `composeWithinBudget` primitive existed, over invented
  fragments, asserting nothing about real content. `tests/load-bearing-contract-gate.test.cjs` now
  derives the load-bearing set from declared `verbatim` strategies rather than a hand-maintained
  list, sweeps a descending budget range, and carries both anti-vacuity guards as executable
  assertions: an empty load-bearing set fails, and a sweep that never applies pressure fails.

  *Decision item 2 overstated what shipped.* It describes a composer that "selects the needed
  fragments and trims by priority to fit that runtime's measured cap". `composeWorkflow` in fact
  calls `composeWithinBudget` with `budget: Number.MAX_SAFE_INTEGER` and every fragment
  `{kind:'verbatim'}` — non-lossiness is a structural guarantee of the strategy set, not a
  large-budget trick, and no per-runtime trimming happens there. The emitted-byte cap is enforced by
  a separate measure-and-fail gate, and Windsurf's limit by a bespoke description truncation
  (#2931), not by this composer. Per-runtime trimming remains available in the strategy set and
  unused; the wording above describes an option, not shipped behavior.

  *`flag:--converge` reaches a terminal state.* #2992 withheld six atoms and deferred them to the
  rollout phase. Five were resolved explicitly. `flag:--converge` was resolved in code by reusing
  `state:plan-strategy-converge` for `autonomous.md`'s converge sections, but that disposition was
  recorded nowhere — the same undocumented-disposition gap #2995 closed for `flag:--verify-only`.
  It is recorded here: **not admitted as its own atom; superseded by `state:plan-strategy-converge`.**

  *Open-questions numbering is corrected.* The list enumerates three questions, while two "Resolved
  by" blocks below resolve a "Question 4" that was never added to it. Question 4 — index keying,
  stable ids vs baked line numbers — is now listed explicitly.
- **Budget unit:** bytes for emission caps (matches `lfByteCount`, deterministic, offline-safe); a token estimate for run-time selection.

  **Corrected by #2931 (Phase 4) — the Windsurf cap was never load-bearing.** The Context
  section above states that the one true emission-time cap, Windsurf's 12,000-byte limit,
  "is a hard `throw` with no graceful fallback", and Phase 4 inherited that as "Windsurf
  installs that currently hard-fail will succeed". Measured on `next` at `640eaee16`, that
  is false. `convertClaudeCommandToWindsurfWorkflow` emits a **stub** — a title, a
  one-line description, and an `@`-reference to the real command body — not an inlined
  workflow. Across all 71 `commands/gsd/*.md` the largest emission is **304 bytes against
  the 12,000-byte cap: 11,696 bytes of headroom, zero commands over.** Reaching the throw
  requires a single frontmatter `description` field of ~11.7 KB.
  `capabilities/windsurf/capability.json` confirms this is the only `commands` converter
  for Windsurf (`destSubpath: workflows`).

  This was wrong at authoring rather than expired: `fc2a7c055` (2026-06-23) introduced
  **both** the stub and the throw in a single commit, one day before this ADR was written
  (2026-06-24). The throw has never guarded a full body.

  Two consequences. First, epic user story 1 — "a solo developer on a capped runtime can
  install and run GSD without hitting size limits" — was **already satisfied** before this
  epic began, because Windsurf already uses the stub + `@-ref` progressive-disclosure model
  this ADR's Decision item 3 describes. Second, the real gap is narrower and was previously
  unstated: **nothing anywhere measures an emitted artifact against its host's declared
  limit.** Phase 4 closes that, and does not "fix Windsurf". The throw is removed in favor
  of truncating the description — the same bound its sibling
  `convertClaudeCommandToWindsurfSkill` already applied — which makes the cap unreachable
  by construction and leaves the 12,000 constant in exactly one place: the guard table.
  That eliminates the `DEFECT.GENERATIVE-FIX` dual-surface duplication this ADR flags,
  rather than adding a parity test for it.
- **Determinism + drift-guard:** every generated artifact follows the universal `--check`/`--write` idiom and is committed; any constant shared between two surfaces gets a `DEFECT.GENERATIVE-FIX` parity assertion. Caps are asserted on **emitted per-runtime bytes** via real spawn-install tests (engine-direct tests are false-green for install behavior).
- **Boundary coverage:** the composer's budget logic is tested at `cap-1 / cap / cap+1` per `RULESET.TESTS.boundary-coverage`.

## Migration path

Sequenced to de-risk — prove the pattern on the smallest surface first, scale last:

1. **This ADR** establishes the platform, the fragment/composer contract, emission-time caps, and the drift-guard requirement.
2. **Prototype the predicate fact-store (Option E)** — *landed with this ADR as a non-shipping reference example* under `examples/dynamic-context-management/` (see Prototype below).
3. **Lift `prompt-budget.cts`** out of the review silo into a shared `context-composer` seam with fast-check property tests + boundary coverage.
4. **Pilot fragmentization on one XL workflow** (`plan-phase.md` or `execute-phase.md`): split into priority-tagged sections + applicability; composer emits per-runtime; prove byte-identical-or-smaller output and green `gsd-test` docker.
5. **Move caps from source to emitted output**; turn the Windsurf `throw` into graceful auto-trim; auto-regenerate size baselines on intentional edits.

   **Superseded in part by ADR-2719 (#2724), which landed after this ADR.** There are no
   size baselines left to auto-regenerate: `tests/workflow-size-baseline.json`,
   `tests/agent-size-baseline.json`, `scripts/update-size-baseline.cjs` and
   `npm run size:baseline` were all deleted, and the differential attribution check is now
   the sole gate (`RULESET.EMITTED_ATTRIBUTION`). ADR-2719 also already moved *hash*
   propagation to emitted per-runtime artifacts across 19 manifests. What it did **not**
   move is the size ratchet, which still keys on source dirs (`currentSizes` reads
   `gsd-core/workflows/*.md` and `agents/*.md` by bare filename). Phase 4 therefore adds an
   absolute per-runtime **cap** over emitted bytes — reusing ADR-2719's existing
   spawn-install walk — and deliberately leaves the growth ratchet source-keyed: re-keying
   it onto the 8,529 emitted paths would turn one acknowledgment per edited file into
   roughly nineteen, which is how a gate becomes something contributors route around.
6. **Wire the init bundle (C)** to emit a per-invocation sections manifest; workflows consume it.
7. **Roll out across LARGE/XL tiers**; update INVENTORY families + parity tests.
8. **(Deferred)** MCP served catalog (ADR-857 §7 / #956).

**Ordering landmine:** any generator consuming compiled output must run *after* `build:lib` (tsc), like `gen-plugin-skills` / `gen-capability-registry`; regenerating before `build:lib` silently drops unbuilt modules (`gsd-inventory-manifest-regen-needs-build`).

## Consequences

**Positive**
- Caps stop biting: each runtime's emitted artifact is measured and trimmed before write.
- A discovered fact lands in one fragment / predicate, not 4 hand-edited surfaces.
- Reuses the existing converter, drift-guard, boundary-test, and `markdown-sectionizer` infrastructure — the net-new pieces are only the fragment model and the composer.
- Opens a path to collapse the 10+ hand-written per-runtime body converters toward a data-driven spec.

**Negative / risks**
- Trimming a load-bearing fragment is a correctness hazard (history: paraphrased `META.RULE` → agent violations). Mitigate with `flexReserve` floors, a Promptfoo-style eval gate, and boundary tests.

  **Amended by #2931 (Phase 4) — the eval gate is deterministic, not model-graded.** A
  *blocking* CI gate driven by exogenously-graded LLM judgment, as Phase 4 originally
  worded it, contradicts two recorded decisions: `PROBE.ci.surface` — "the contract
  (parse/validate, projection round-trip, fail-closed guards), **NEVER the LLM judgment**"
  (ADR-550 D5) — and `PROHIB.judgment-tier` — "never-silent / never-hard-halt soft gate"
  (ADR-550 D4). `PROHIB.recall` further records that there is no compiled prohibition-probe
  recall engine to source an assertion set from; the `PROHIB.*`/`PROBE.*` classes describe
  the *architecture* of that subsystem, not a corpus of prohibitions about workflow content.

  The gate therefore asserts the **contract**, which is both blocking and deterministic:
  `composeWithinBudget` already returns `omitted`, `shrunk`, `floored` and `isolatePrefix`,
  so the gate proves no fragment declared load-bearing was omitted or shrunk, that a
  floored fragment is a success rather than a finding, and that the `isolate` prefix
  survives byte-identical. It carries an explicit anti-vacuity rule — an empty
  load-bearing set fails, because a gate asserting over nothing proves nothing. No model
  participates. This satisfies the mitigation this section asks for while honoring D4/D5.
- Per-runtime emission multiplies artifacts across the 15 × N matrix (inventory/parity surface).
- Build-order fragility (must run after `build:lib`).
- Dual-surface drift if any future MCP channel is added — requires parity assertions.

## Prototype (step 2, Option E) — non-shipping reference example

A working prototype proves the platform pattern end-to-end. It ships as a **reference example only**, under `examples/dynamic-context-management/` — deliberately outside the build (`src/` → `bin/lib/`), the npm package `files[]`, the installer, and the CI test suite (`tests/`). Nothing in it is compiled into or installed with GSD; the production implementation lands in a later phase.

- `examples/dynamic-context-management/context-predicates.cjs` — pure parser/selector: `parsePredicates(markdown)` (handles bare and list-item backtick predicate forms, splits on first `=`, skips fenced code / blockquote prose, detects duplicate IDs), `selectPredicates(predicates, {klass, prefix, contains})` (the JIT "task → predicate set" selector), and `buildIndex(predicates)` (deterministic, sorted).
- `examples/dynamic-context-management/gen-context-index.cjs` — self-contained CLI with `--check`/`--write` drift-guard plus a `--select <query>` mode demonstrating JIT brief assembly.
- `examples/dynamic-context-management/CONTEXT-INDEX.json` — sample generated index: **415 predicates, 20 classes** (verified 2026-07-31; down from 416 after #2928/PR #2938 reconciled the last duplicate predicate ID, `RULESET.WORKFLOW_MARKDOWN.FENCES`). Originally committed as **393 predicates, 18 classes** (2026-06-24); `CONTEXT.md` has since gained the `PROBE` (11) and `PROHIB` (10) classes, with `DEFECT` 161→167 and `RULESET` 59→56→55. The committed artifact had gone stale (`--check` exited 1) and was regenerated with `--write`.
- `examples/dynamic-context-management/demo.cjs` + `README.md` — runnable usage example and notes.

During research the slice was validated with 42 behavioral tests (predicate forms, fenced-code / prose skipping, duplicate-id detection, the selector, a deterministic index, and a fast-check property test); those landed as CI tests under `tests/` with the production implementation (#2928/PR #2938).

The prototype immediately surfaced **3 latent duplicate predicate IDs** in `CONTEXT.md` (`RULESET.WORKFLOW_MARKDOWN.FENCES`, `RULESET.GEMINI.TOOLS.ask_user`, `RULESET.GEMINI.TEST_SENTINEL`) — integrity drift no existing tool catches.

**Re-checked 2026-07-31:** the two `RULESET.GEMINI.*` duplicates were removed along with the Gemini runtime, not reconciled deliberately; the remaining `RULESET.WORKFLOW_MARKDOWN.FENCES` duplicate was reconciled deliberately in #2928/PR #2938, which also productionized `--check` into CI so it now fails closed on any *new* duplicate ID.

**Phase 0 acceptance status (2026-07-31).** The epic's Phase 0 criterion — "`gen-context-index --check` green in CI" — was **unmet**: `--check` exited 1 against `next`, and no CI job failed, because the example sits deliberately outside `tests/` — the red was invisible to the pipeline. The index has now been regenerated and `--check` exits 0.

That is a point-in-time true-up, not a fix. Per Open question 4, the index is keyed on baked `line` numbers, so it will re-drift on the next `CONTEXT.md` line shift. The criterion stays fragile until the keying changes — and it stays *silently* fragile for as long as the drift-guard remains outside CI.

Prototype scope notes: the parser is intentionally self-contained for the example; production should consume the compiled `markdown-sectionizer` seam, live under `src/` → `bin/lib/`, and be drift-guarded by a generator wired into the build **after** `build:lib`.

**Done (#2928).** Production landed under `src/context-predicates.cts` → `gsd-core/bin/lib/context-predicates.cjs` (ADR-457 build-at-publish). Fence-aware line skipping mirrors `markdown-sectionizer.cts`'s exported `scanFencedBlocks` delimiter-matching rule exactly (byte-for-behavior parity proven by a dedicated test suite) via a LOCAL, interleaved single pass, rather than a call into that seam directly: a two-pass design (mask comments, then call `scanFencedBlocks`, or the reverse) cannot correctly resolve mutual precedence between HTML comments and fences in both directions — a fence delimiter inside a real comment (with no later real closer) was found to falsely skip the rest of the file to EOF, and the converse ordering falsely let a comment token inside a real fence leak past the fence's own close — so the two constructs are scanned together, each suppressing the other's open/close detection while active (post-#2928-review fix; see `src/context-predicates.cts`'s module doc comment). `scripts/gen-context-index.cjs --check`/`--write` is wired into `lint:generated-sync` (so `lint:ci`, CI-gated) and into `build` (after `build:lib`) and `regen:derived`; the selector is exposed live via `gsd-tools query context-predicates --class|--prefix|--contains`.

## Open questions

1. Fragment unit: separate files vs in-file section markers?
2. Build-time emission vs run-time assembly as the primary surface during migration (double-write vs per-workflow cutover)?
3. Whether/when to invest in per-runtime native channels (skills, MCP) above the universal file floor.
4. Index keying: stable IDs vs baked `line` numbers? *(Resolved by #2928 — see below.)*

**Resolved by #2928 — index keying: stable IDs, with no `line` field at all.** Question 4 asked stable IDs vs baked `line` numbers: `CONTEXT-INDEX.json` stored each predicate's `line`, so `--check` re-drifted on *any* `CONTEXT.md` line shift — a typo fix three sections up failed the gate. Raised by @davesienkowski (#1671, 2026-06-25). The shipped resolution is **stronger than the option originally proposed** (keying the comparison on stable IDs with `line` retained as non-compared metadata): the committed `ContextIndex.predicates` entries carry **no `line` field at all**. Committed-but-uncompared metadata goes silently stale — the same defect class the drift-guard exists to catch, with the alarm removed — so it was dropped from the committed artifact rather than merely excluded from the comparison. `line` is still returned by the live `parsePredicates`/`gsd-tools query context-predicates` result for callers that want to cite a source location; only the committed `docs/CONTEXT-INDEX.json` shape omits it.

**Resolved by other work — not carried as open.** A fourth question was proposed in review (#1671, 2026-06-25): *what populates the eval-gate assertion set, and is it graded exogenously?* Since that review, the answer has landed as first-class predicate classes rather than remaining a design gap: `PROBE.principle` (`verifier-reach-equals-spec-reach`), `PROBE.family` (edge-probe + prohibition-probe + ui-consideration-probe), `PROBE.protocol` (recall → precision), and `PROHIB.judgment-tier` (exogenous grading) — see ADR-550 D4/D7 and ADR-1606. The `PROHIB.*` predicates live in the same `CONTEXT.md` store this ADR formalizes, which is the single-store property that review asked for.

**Resolved by #2930 (Phase 3) — fragment unit: in-file `<!-- gsd:section id= when= -->` markers.** Question 1 asked separate files vs in-file section markers. Confirmed with the maintainer: separate files are eliminated by this phase's own acceptance criterion — "emitted output byte-identical-or-smaller" — because splitting a workflow into files changes the emitted tree's *shape*, which is neither identical nor smaller, it is different; it also multiplies INVENTORY rows and `@`-ref contract surface for no Phase-3 benefit. A sidecar fragment manifest keyed on heading anchors was also rejected: zero source growth, but it creates a second surface that drifts from the workflow — the exact multi-surface edit pain the epic exists to remove (`DEFECT.GENERATIVE-FIX`), and directly against the epic's "one fragment, not 4 surfaces" thesis. The shipped answer is in-file markers, stripped at emit so the installed artifact carries no build metadata and shrinks; markers are self-anchoring (no line-number keying — Open question 4 already rejected that for the predicate index, and the same reasoning applies here), and the existing `<!-- gsd:loop-host … -->` block at `plan-phase.md:1` is in-repo precedent for the form. Production landed under `src/workflow-fragments.cts` → `gsd-core/bin/lib/workflow-fragments.cjs` (ADR-457 build-at-publish), piloted on `execute-phase.md`. **The pilot was retargeted from `plan-phase.md` mid-phase, and the reason is itself the most important finding here.** The branches the epic names as motivating (`--prd`, `--ingest`, `--mvp`, `--reviews`) all live in `plan-phase.md` — but `plan-phase.md` sits only 36 B under an independent, pre-existing size gate (`tests/phase6-capstone-conformance.test.cjs`'s `PRE_PHASE6`, an ADR-857 Phase-6 completion property that this ADR's own Blast-radius analysis did not enumerate against, catching only the XL cap). It cannot absorb even the smallest marker overhead, so **it could not be fragmentized at all under this phase's grammar**, independent of any shape limitation. The pilot instead proves the mechanism on state- and flag-gated `<step>` blocks in `execute-phase.md` (`partial-wave`/`flag:--wave`, `gap-closure-artifacts`/`state:gap-closure-phase`, `regression-gate`/`state:has-prior-phases`), which has 728 B of real headroom under its own `PRE_PHASE6` gate. This is direct evidence for the epic's premise that fragmentization pays off, but it also means **Phase 4 (moving size caps from source bytes to emitted bytes) may need to land before `plan-phase.md` itself can be fragmentized.** Separately, and independent of the size-gate finding: the marker grammar addresses SECTION-shaped branches only — a whole-line, non-nesting comment pair around a contiguous block — and `--mvp`'s content in `plan-phase.md` is INTERLEAVED rather than sectioned (`MVP_MODE` resolution shares a bash block with `--tdd`/`--no-tracer`/`--no-reversibility-gates` at `plan-phase.md:125-158`, and is inline `${MVP_MODE === 'true' ? ... }` template interpolation at `:794-803`), so `--mvp` would remain unmarkable by this grammar even if the size gate allowed it. Phase 6 must either accept that gap or introduce a finer-grained (sub-line) mechanism for interleaved branches.

**Resolved by #2992 (Phase 6.1) — the gap is ACCEPTED, and it is closed by measurement rather than by mechanism.** Phase 6 initially chose to build the sub-line mechanism. Measuring the two sites first falsified the premise that choice rested on. `plan-phase.md:125-158` is not optional content at all: it is `MVP_MODE` **resolution** (alongside `--tdd` / `--no-tracer` / `--no-reversibility-gates`), which must execute on every invocation in order to resolve the flags — gating it would break the workflow rather than trim it. `plan-phase.md:794-803` is genuinely conditional, but it is roughly **340 bytes** and is *already* a lazy pointer: its body instructs the planner to read `references/planner-mvp-mode.md`, so the heavy content is deferred by the existing `@`-reference model, not carried inline. A sub-line grammar would therefore buy about 340 bytes at one site while the other site must never be gated at all — and it would reintroduce exactly the Greenspun's-Tenth-Rule hazard the applicability-grammar bullet above exists to prevent, in exchange for that. The gap this ADR identified is real as a *shape* observation and inconsequential as a *value* one. `--mvp` remains unmarkable by the section grammar, deliberately and permanently; the section-shaped branches of `plan-phase.md` are still fragmentized normally. Should an interleaved branch later carry genuinely large, genuinely skippable content, that measurement — not this precedent — is what should reopen the question.

**Resolved by #2930 (Phase 3) — build-time emission is the primary surface; per-workflow cutover, no double-write.** Question 2 asked build-time emission vs run-time assembly as the primary surface during migration, and whether that requires a double-write period. Because markers are stripped at emit, an unmarked workflow parses to exactly one implicit fragment and composes back byte-identical by construction — that structural guarantee is what makes a per-workflow cutover safe file-by-file, with no double-write period and no flag day: a workflow can gain markers on its own schedule without touching any other workflow's emission path. Phase 5's run-time selection is planned to consume a build-derived manifest, not markers read at run time, keeping the run-time surface decoupled from the authoring surface.

## Related

- ADR-0002 — Command Contract Validation Module (the stub `<execution_context>` @-ref contract this platform's emission must keep satisfying).
- ADR-457 — build-at-publish generation model (the codegen + drift-guard precedent the composer extends).
- ADR-857 §7 — Connected-Capability / MCP contract (the deferred served-catalog channel).

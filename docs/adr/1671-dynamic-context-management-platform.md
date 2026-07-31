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
- **Composer contract:** priority + binary-search cutoff to a per-runtime budget; `flexReserve`-style floors for load-bearing fragments (`META.RULE` citation rules, contribution gates, closing-keyword rules); a byte-stable canonical prefix (`<isolate>`) kept identical across runtimes to preserve KV-cache warmth and keep launcher-parity tests green.
- **Budget unit:** bytes for emission caps (matches `lfByteCount`, deterministic, offline-safe); a token estimate for run-time selection.
- **Determinism + drift-guard:** every generated artifact follows the universal `--check`/`--write` idiom and is committed; any constant shared between two surfaces gets a `DEFECT.GENERATIVE-FIX` parity assertion. Caps are asserted on **emitted per-runtime bytes** via real spawn-install tests (engine-direct tests are false-green for install behavior).
- **Boundary coverage:** the composer's budget logic is tested at `cap-1 / cap / cap+1` per `RULESET.TESTS.boundary-coverage`.

## Migration path

Sequenced to de-risk — prove the pattern on the smallest surface first, scale last:

1. **This ADR** establishes the platform, the fragment/composer contract, emission-time caps, and the drift-guard requirement.
2. **Prototype the predicate fact-store (Option E)** — *landed with this ADR as a non-shipping reference example* under `examples/dynamic-context-management/` (see Prototype below).
3. **Lift `prompt-budget.cts`** out of the review silo into a shared `context-composer` seam with fast-check property tests + boundary coverage.
4. **Pilot fragmentization on one XL workflow** (`plan-phase.md` or `execute-phase.md`): split into priority-tagged sections + applicability; composer emits per-runtime; prove byte-identical-or-smaller output and green `gsd-test` docker.
5. **Move caps from source to emitted output**; turn the Windsurf `throw` into graceful auto-trim; auto-regenerate size baselines on intentional edits.
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
- Per-runtime emission multiplies artifacts across the 15 × N matrix (inventory/parity surface).
- Build-order fragility (must run after `build:lib`).
- Dual-surface drift if any future MCP channel is added — requires parity assertions.

## Prototype (step 2, Option E) — non-shipping reference example

A working prototype proves the platform pattern end-to-end. It ships as a **reference example only**, under `examples/dynamic-context-management/` — deliberately outside the build (`src/` → `bin/lib/`), the npm package `files[]`, the installer, and the CI test suite (`tests/`). Nothing in it is compiled into or installed with GSD; the production implementation lands in a later phase.

- `examples/dynamic-context-management/context-predicates.cjs` — pure parser/selector: `parsePredicates(markdown)` (handles bare and list-item backtick predicate forms, splits on first `=`, skips fenced code / blockquote prose, detects duplicate IDs), `selectPredicates(predicates, {klass, prefix, contains})` (the JIT "task → predicate set" selector), and `buildIndex(predicates)` (deterministic, sorted).
- `examples/dynamic-context-management/gen-context-index.cjs` — self-contained CLI with `--check`/`--write` drift-guard plus a `--select <query>` mode demonstrating JIT brief assembly.
- `examples/dynamic-context-management/CONTEXT-INDEX.json` — sample generated index: **416 predicates, 20 classes** (regenerated 2026-07-31). Originally committed as **393 predicates, 18 classes** (2026-06-24); `CONTEXT.md` has since gained the `PROBE` (11) and `PROHIB` (10) classes, with `DEFECT` 161→167 and `RULESET` 59→56. The committed artifact had gone stale (`--check` exited 1) and was regenerated with `--write`.
- `examples/dynamic-context-management/demo.cjs` + `README.md` — runnable usage example and notes.

During research the slice was validated with 42 behavioral tests (predicate forms, fenced-code / prose skipping, duplicate-id detection, the selector, a deterministic index, and a fast-check property test); those return as CI tests under `tests/` with the production implementation.

The prototype immediately surfaced **3 latent duplicate predicate IDs** in `CONTEXT.md` (`RULESET.WORKFLOW_MARKDOWN.FENCES`, `RULESET.GEMINI.TOOLS.ask_user`, `RULESET.GEMINI.TEST_SENTINEL`) — integrity drift no existing tool catches.

**Re-checked 2026-07-31:** only **one** remains — `RULESET.WORKFLOW_MARKDOWN.FENCES`. The two `RULESET.GEMINI.*` duplicates were removed along with the Gemini runtime, not reconciled deliberately. Production `--check` can be made to fail on *new* duplicates once that single remaining ID is reconciled.

**Phase 0 acceptance status (2026-07-31).** The epic's Phase 0 criterion — "`gen-context-index --check` green in CI" — was **unmet**: `--check` exited 1 against `next`, and no CI job failed, because the example sits deliberately outside `tests/` — the red was invisible to the pipeline. The index has now been regenerated and `--check` exits 0.

That is a point-in-time true-up, not a fix. Per Open question 4, the index is keyed on baked `line` numbers, so it will re-drift on the next `CONTEXT.md` line shift. The criterion stays fragile until the keying changes — and it stays *silently* fragile for as long as the drift-guard remains outside CI.

Prototype scope notes: the parser is intentionally self-contained for the example; production should consume the compiled `markdown-sectionizer` seam, live under `src/` → `bin/lib/`, and be drift-guarded by a generator wired into the build **after** `build:lib`.

## Open questions

1. Fragment unit: separate files vs in-file section markers?
2. Build-time emission vs run-time assembly as the primary surface during migration (double-write vs per-workflow cutover)?
3. Whether/when to invest in per-runtime native channels (skills, MCP) above the universal file floor.
4. **Index keying: stable IDs vs baked `line` numbers.** `CONTEXT-INDEX.json` stores each predicate's `line`, so `--check` re-drifts on *any* `CONTEXT.md` line shift — a typo fix three sections up fails the gate. Phase 1 promotes `--check` to a CI gate, where that makes it routinely red for reasons unrelated to predicate integrity. Keying the comparison on stable IDs, with `line` retained as non-compared metadata, is the candidate fix. Raised by @davesienkowski (#1671, 2026-06-25) and confirmed on `next` 2026-07-31.

**Resolved by other work — not carried as open.** A fourth question was proposed in review (#1671, 2026-06-25): *what populates the eval-gate assertion set, and is it graded exogenously?* Since that review, the answer has landed as first-class predicate classes rather than remaining a design gap: `PROBE.principle` (`verifier-reach-equals-spec-reach`), `PROBE.family` (edge-probe + prohibition-probe + ui-consideration-probe), `PROBE.protocol` (recall → precision), and `PROHIB.judgment-tier` (exogenous grading) — see ADR-550 D4/D7 and ADR-1606. The `PROHIB.*` predicates live in the same `CONTEXT.md` store this ADR formalizes, which is the single-store property that review asked for.

## Related

- ADR-0002 — Command Contract Validation Module (the stub `<execution_context>` @-ref contract this platform's emission must keep satisfying).
- ADR-457 — build-at-publish generation model (the codegen + drift-guard precedent the composer extends).
- ADR-857 §7 — Connected-Capability / MCP contract (the deferred served-catalog channel).

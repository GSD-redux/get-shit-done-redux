# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for GSD.

Each ADR documents one architectural decision: what was decided, why, and what consequences follow. ADRs are append-only. Amendments extend existing ADRs with a dated section rather than replacing them.

## Reading this corpus

**Start with the [index](#index) below, and respect the status.** The index is grouped so that the first table — *Active decisions* — is the set that governs the system as it stands. An ADR in *Superseded, Retired, and Legacy* is historical: it records what was once decided and names what replaced it. Do not cite it as current architecture.

Two things the index makes explicit, because getting them wrong has actually misled readers here:

- **"Read first"** on an active ADR points at a *broader* ADR that now frames it. A decision can be entirely correct and still not be the whole picture. The runtime capability descriptor ([ADR-1016](1016-runtime-capability-descriptor.md)) is live and load-bearing, but [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (**EoS** — GSD as an Embeddable Orchestration Engine) subsumes it as the *declarative adapter* and inverts its direction: GSD is the engine a host embeds, not an installer that projects onto a host. For **how GSD meets a host, EoS is the current frame.**
- **`Proposed` means not ratified — and it is kept honest.** On 2026-07-17 the corpus was audited against the shipped tree and nine ADRs whose decisions had demonstrably shipped were ratified to `Accepted`, each carrying a dated **Ratification** section with the evidence (see [ADR-857](857-capability-system.md) for the fullest example). The ADRs that remain `Proposed` are `Proposed` **for a reason recorded in the file** — an unmet acceptance criterion, an outstanding phase, or a successor ADR already planned — not through neglect. Trust the label; if you think it is wrong, prove it in a dated section and see [Ratifying a stale `Proposed`](#ratifying-a-stale-proposed).

## Naming Convention

New ADRs use **issue#-prefix slug** naming:

```text
docs/adr/<issue#>-<kebab-slug>.md
```

Examples: `2264-golden-parity-redesign.md`, `1239-gsd-embeddable-orchestration-engine.md`.

### Why

Two developers computing "next ADR number" locally against `main` will independently pick the same integer and both ship. The collision is already on disk — `0010-*` exists twice and `0011-*` exists three times. GitHub issue numbers are server-assigned and atomic: the moment you open an issue, that number is reserved globally. Two PRs that both edit the `### Fixed` block of `CHANGELOG.md` always conflict on merge — two PRs that each use a distinct issue# as their ADR prefix never collide. Same shape, same solution.

### Legacy *naming* is not `Legacy` *status*

Files `0001-*` through `0012-*` (and `0174-*`) are preserved as immutable historical record of the old local-compute numbering. The duplicate `0010-*` and the three-way `0011-*` are documented residue of that convention — not patterns to imitate. **Do not renumber them.**

This is a statement about **filenames only**. Many of those ADRs are `Accepted` and load-bearing today ([ADR-0002](0002-command-contract-validation-module.md), [ADR-0004](0004-worktree-workstream-seam-module.md), [ADR-0008](0008-installer-migration-module.md), [ADR-0009](0009-shell-command-projection-module.md)). An old filename says nothing about whether a decision still holds. The `Legacy` **status** in the table below is a separate claim — see the vocabulary.

Because `0010-*` and `0011-*` each resolve to more than one file, a bare cross-reference like "ADR-0011" is genuinely ambiguous. Link the file (see [Lifecycle rules](#lifecycle-rules)).

### Full process

See **[CONTRIBUTING.md — "Proposing an ADR or PRD"](../../CONTRIBUTING.md#proposing-an-adr-or-prd)** for the end-to-end workflow: opening the issue, waiting for approval, naming the file, and submitting the PR.

PRDs live in [`docs/prd/`](../prd/), not here. ([`0011-review-default-reviewers-prd.md`](0011-review-default-reviewers-prd.md) predates that directory and is kept in place as frozen historical record.)

## Lifecycle rules

These are enforced by `scripts/gen-adr-index.cjs`, which runs in CI via `npm run lint:generated-sync`. A violation fails the build with the exact file and fix.

### 1. Every ADR declares one status from the canonical vocabulary

The first word of the `Status` field must be one of:

| Status | Means | Obligation |
|--------|-------|------------|
| `Accepted` | Decided and in force. Cite it. | — |
| `Proposed` | Decided in principle, not ratified. Do not cite as settled. | If the work has demonstrably shipped, ratify it (below) — do not leave the label lying. |
| `Superseded` | A specific newer ADR replaced this decision. | **Must name the successor as a file link.** |
| `Retired` | What this ADR decided no longer exists at all, and no single ADR replaced it. | Say what was removed and when. |
| `Legacy` | Frozen historical record, kept for provenance; not a pattern to follow. | Say why it is frozen. |

Prose may follow the token (`Superseded by [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) (2026-05-23); originally Accepted (2026-05-09)`). Both the bullet form (`- **Status:** Accepted`) and the table form (`| **Status** | Accepted |`) are accepted.

### 2. Cross-references to other ADRs are file links, never bare ids

Write `[ADR-0011](0011-skill-surface-budget-module.md)`, not `ADR-0011`. Bare ids are ambiguous for `0010`/`0011`, and unlinked references cannot be checked.

If you mean an **issue**, write `#857` — not `ADR-857`. (An ADR and its owning issue often share a number; that is intentional and not a conflict.)

### 3. Supersession and subsumption are symmetric

These are different relations. Do not conflate them:

- **`Supersedes` / `Superseded by`** — the target is *replaced*. Its status becomes `Superseded`.
- **`Subsumes` / `Subsumed by`** — the target *still holds*, but a broader ADR now frames it. Its status is **unchanged**; it becomes a component of the larger decision.

If A declares either relation toward B, **B must record the reciprocal.** A one-way pointer is the failure this corpus actually suffered: [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) declared it subsumed four ADRs, none of which said so, and none of which pointed back — so a reader landing on any of them concluded the superseded frame was the way forward.

Only an `Accepted` ADR is owed the back-link. A `Proposed` ADR's claim is **prospective**: it has not taken effect, so its target is not marked. On ratification, the check begins demanding the back-links.

### 4. The declared id matches the filename

An H1 of `# ADR-0175: …` in a file named `218-*.md` is a rename that never finished. The id in the title must match the filename's prefix.

### Ratifying a stale `Proposed`

A stale `Proposed` is not cosmetic: it tells contributors and agents that live architecture is an unbuilt idea. Fix it — but on evidence, not vibes.

**The bar.** All four must hold before flipping to `Accepted`:

1. The decided mechanism demonstrably **exists** in the tree — name the files, symbols, and tests.
2. The owning issue is closed **as completed**. A closed issue is not proof: `stateReason` of *not planned* / duplicate means the decision was **dropped** (that is `Legacy` or `Retired`, not `Accepted`).
3. **No material part is unshipped.** If the ADR defines phases and one is outstanding, or states its own bar for acceptance and that bar is unmet, it stays `Proposed`.
4. No later ADR supersedes it, and no approved issue already plans its graduation as separate work.

**The procedure.** Set the status to `Accepted — ratified <date> (originally Proposed <date>)`, add a dated `## Ratification` section holding the evidence, then run `node scripts/gen-adr-index.cjs --write`. If the ADR claims to supersede or subsume others, the gate will now demand their back-links — that is the point. Ratify deliberately.

**Two traps worth knowing**, both hit during the 2026-07-17 audit:

- **Shipped code is necessary, not sufficient.** Eight ADRs had every named module, symbol, and test present and their epics closed — and still failed the bar: [ADR-2264](2264-golden-parity-redesign.md)'s own headline acceptance criterion is unmet in the tree, [ADR-230](230-introduce-next-integration-branch.md)'s decided branch protection does not match the live API, [ADR-660](660-release-from-next-head.md)'s namesake mechanism is performed by hand, and [ADR-959](959-capability-command-contribution.md) has an approved issue planning its graduation as its own ADR. Verify the *decision*, not just the code.
- **"Supersedes" is often "subsumes".** Read what the ADR means before the gate makes you act on what it says. [ADR-857](857-capability-system.md) said "Supersedes (generalizes)"; taken literally, ratifying it would have stamped two live seams ([ADR-0011](0011-skill-surface-budget-module.md), [ADR-58](58-runtime-install-policy-module.md)) as dead. The parenthetical was the truth; the field name was wrong.

## Maintaining the index

**The index is generated. Do not hand-edit it.** Everything between the `ADR-INDEX:START` / `ADR-INDEX:END` markers is derived from the ADR files themselves:

```bash
node scripts/gen-adr-index.cjs            # print the index
node scripts/gen-adr-index.cjs --write    # regenerate it into this file
node scripts/gen-adr-index.cjs --check    # CI: fail if stale or invalid
```

After adding an ADR, or changing any ADR's status or relations, run `--write` and commit the result. `npm run lint:generated-sync` runs `--check` in CI, so a missing or stale row fails the build rather than rotting silently.

This replaces a hand-maintained table that had drifted to **40 of 65 ADRs** — the entire capability family and EoS itself were missing from it, which is precisely why the ADRs a reader most needed were the ones they could not find.

## Index

<!-- ADR-INDEX:START — generated by scripts/gen-adr-index.cjs; do not edit by hand -->

### Active decisions (53)

These govern the system as it stands. Cite these.

| ADR | Title | Status | Read first |
|-----|-------|--------|------------|
| [ADR-0001](0001-dispatch-policy-module.md) | Dispatch policy module as single seam for query execution outcomes | Accepted | — |
| [ADR-0002](0002-command-contract-validation-module.md) | Command Contract Validation Module | Accepted | — |
| [ADR-0003](0003-model-catalog-module.md) | Model Catalog Module as single source of truth for agent profiles and runtime tier defaults | Accepted | — |
| [ADR-0004](0004-worktree-workstream-seam-module.md) | Planning Workspace Module as single seam for worktree and workstream state | Accepted | — |
| [ADR-0006](0006-planning-path-projection-module.md) | Planning Path Projection Module for SDK query handlers | Accepted | — |
| [ADR-0008](0008-installer-migration-module.md) | Installer Migration Module owns install-time upgrade safety | Accepted | — |
| [ADR-0009](0009-shell-command-projection-module.md) | Shell Command Projection Module owns runtime-aware OS command rendering | Accepted | — |
| [ADR-0011](0011-review-default-reviewers.md) | `review.default_reviewers` config key scopes the no-flag `/gsd-review` fan-out | Accepted | — |
| [ADR-0011](0011-skill-surface-budget-module.md) | Skill Surface Budget Module owns install-time profile staging and runtime surface control | Accepted | [ADR-857](857-capability-system.md) |
| [ADR-15](15-autonomous-cross-ai-convergence.md) | Cross-AI Plan Convergence via Existing Orchestration Commands | Accepted | — |
| [ADR-22](22-plan-drift-guard.md) | Plan-vs-codebase drift guard: defaults and symbol-resolver seam | Accepted | — |
| [ADR-58](58-runtime-install-policy-module.md) | Runtime Install Policy Module owns the typed install-plan projection | Accepted | [ADR-1239](1239-gsd-embeddable-orchestration-engine.md), [ADR-857](857-capability-system.md) |
| [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) | Retire @opengsd/gsd-sdk package boundary — single-runtime collapse | Accepted | — |
| [ADR-218](218-release-version-validation.md) | Harden release-workflow version validation — reject leading zeros and pre-check npm | Accepted | — |
| [ADR-227](227-input-validation-shape-not-just-type.md) | Input validation must check semantic shape, not just type | Accepted | — |
| [ADR-415](415-prevent-stale-base-token-reintroduction.md) | Prevent stale-base reintroduction of retired runtime tokens | Accepted | — |
| [ADR-452](452-eslint-lint-harness.md) | Adopt standard ESLint flat-config lint harness | Accepted | — |
| [ADR-456](456-test-rigor-architecture.md) | Test-rigor architecture — deterministic scheduling, antagonistic tier, typed-surface mandate, and delete-bad-tests policy | Accepted | — |
| [ADR-457](457-generated-cjs-single-source.md) | Generation model for `bin/lib/*.cjs` type safety | Accepted | — |
| [ADR-550](550-spec-phase-probe-contract.md) | spec-phase probe pattern and prohibition contract | Accepted | — |
| [ADR-0656](0656-research-module-seam.md) | Research Module — L2-hybrid seam for cached, curated-first research | Accepted | — |
| [ADR-766](766-claude-code-plugin-manifest-module.md) | Claude Code Plugin Manifest Module owns the projection of gsd-core surfaces onto the Claude Code plugin contract | Accepted | — |
| [ADR-857](857-capability-system.md) | Capability system — five-step loop as core, features as plug-ins behind Loop Extension Points | Accepted | — |
| [ADR-894](894-capability-declaration-format.md) | Capability declaration format + registry generation | Accepted | [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) |
| [ADR-959](959-capability-command-contribution.md) | Capability Command Contribution | Accepted | — |
| [ADR-1016](1016-runtime-capability-descriptor.md) | Runtime Capability Descriptor | Accepted | [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) |
| [ADR-1235](1235-descriptor-driven-agent-conversion-migration.md) | Migrate agent conversion to the descriptor-driven install path | Accepted | — |
| [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) | GSD as an Embeddable Orchestration Engine | Accepted | — |
| [ADR-1244](1244-capability-ecosystem.md) | Capability Ecosystem: third-party authoring, versioned manifests, and URL import/upgrade/remove | Accepted | — |
| [ADR-1372](1372-markdown-sectionizer-seam.md) | Canonical markdown-structure parsing — the `markdown-sectionizer` seam | Accepted | — |
| [ADR-1411](1411-resolution-provenance.md) | Resolution must report provenance, not fall open silently | Accepted | — |
| [ADR-1508](1508-runtime-artifact-conversion-module.md) | Runtime Artifact Conversion Module owns per-runtime content rewriting | Accepted | — |
| [ADR-1517](1517-reviewer-instances-config-surface.md) | Reviewer instances — bounded config surface for same-adapter multi-model review | Accepted | — |
| [ADR-1577](1577-untrusted-input-boundary-and-injection-blocking.md) | Untrusted-input boundary + opt-in injection blocking | Accepted | — |
| [ADR-1593](1593-skill-mapping-converter-methodology.md) | Skill mapping & converter methodology across runtimes | Accepted | — |
| [ADR-1610](1610-workflow-agent-size-budget-ratchet.md) | workflow & agent size-budget ratchet (per-file byte baseline + tier hard caps) | Accepted | — |
| [ADR-1703](1703-portability-enforcement-architecture.md) | Cross-platform portability enforcement as AST ESLint rules | Accepted | — |
| [ADR-1769](1769-state-md-transition-module.md) | STATE.md Transition Module — intent-based transitions over scattered RMW callbacks | Accepted | — |
| [ADR-1787](1787-gsd-next-smart-entry.md) | `/gsd:next` smart-entry front door delegates advancement to `/gsd:progress --next` | Accepted | — |
| [ADR-1817](1817-state-md-rebuild-derivability-contract.md) | STATE.md rebuild — derivability contract (capstone transition) | Accepted | — |
| [ADR-1820](1820-spec-optional-predicate-rail.md) | Spec-Optional Predicate Rail — the Spec-Section Detection Module, the fallback toggle, and the SPEC↔probe precedence contract | Accepted | — |
| [ADR-1866](1866-agent-skills-dual-injection-contract.md) | agent_skills dual injection — orchestrator-side + agent-side self-load | Accepted | — |
| [ADR-1990](1990-existing-code-onboarding.md) | Existing Code Onboarding Module owns deterministic repo-state detection and onboarding route selection | Accepted | — |
| [ADR-2008](2008-command-exit-zero-gate.md) | Generic gate-predicate evaluator (`command-exit-zero`) | Accepted | — |
| [ADR-2121](2121-phase-identifier-parsing-consolidation.md) | Phase-Identifier Parsing Consolidation | Accepted | — |
| [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) | Markdown Table Model, Bounded Mutation, and Fail-Loud Consolidation (#1372 part 2) | Accepted | — |
| [ADR-2164](2164-statusline-scope-boundary.md) | Statusline draws its data boundary at local, read-only sources | Accepted | — |
| [ADR-2207](2207-status-field-lifecycle-ownership.md) | STATE.md `Status` lifecycle — phase-completion writes an intermediate state; milestone-close owns termination | Accepted | — |
| [ADR-2346](2346-command-dispatch-completion.md) | Command Dispatch Completion | Accepted | — |
| [ADR-2629](2629-phase-effort-estimation-calibration.md) | Phase effort is estimated against a calibrated smart-zone budget, not a static heuristic | Accepted | — |
| [ADR-2719](2719-emitted-artifact-attribution.md) | Emitted-artifact attribution — replace the committed parity fixtures with a computed conservation law | Accepted | — |
| [ADR-2782](2782-reviewer-lane-capability-surface.md) | Reviewer Lane — the cross-AI reviewer handoff becomes a declared capability surface | Accepted | — |
| [ADR-3660](3660-runtime-artifact-layout-module.md) | Runtime Artifact Layout Module owns per-runtime artifact placement | Accepted | [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) |

### Proposed (8)

Decided in principle, not yet ratified. Do not cite as settled architecture.

| ADR | Title | Status | Read first |
|-----|-------|--------|------------|
| [ADR-230](230-introduce-next-integration-branch.md) | Introduce `next` as a long-lived integration branch | Proposed | — |
| [ADR-443](443-opus48-unified-effort-and-fast-mode-routing.md) | Unified cross-provider effort controls and fast-mode-aware routing | Proposed | — |
| [ADR-612](612-bracket-phase-id-convention.md) | Bracket Phase-ID Convention | Proposed | — |
| [ADR-660](660-release-from-next-head.md) | Release from the head of `next`; immutable release tags; `@next` dist-tag as the RC surface | Proposed | — |
| [ADR-1143](1143-claude-orchestration-capability.md) | Claude orchestration capability — Workflow tool (ultracode) as a runtime-gated loop execution backend | Proposed | — |
| [ADR-1213](1213-capability-state-writer.md) | Capability write side — the Capability State Writer | Proposed | — |
| [ADR-1606](1606-prohibition-enforcement-verify-seam.md) | prohibition-enforcement verify-time seam | Proposed | — |
| [ADR-1671](1671-dynamic-context-management-platform.md) | Dynamic context management platform | Proposed | — |

### Superseded, Retired, and Legacy (8)

Historical record. **Do not follow these** — each names what replaced it, or why it was retired.

| ADR | Title | Status | Replaced by |
|-----|-------|--------|-------------|
| [ADR-0005](0005-sdk-architecture-seam-map.md) | SDK Architecture seam map for query/runtime surfaces | Superseded | [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) |
| [ADR-0007](0007-sdk-package-seam-module.md) | SDK Package Seam Module owns SDK-to-get-shit-done-redux compatibility | Superseded | [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) |
| [ADR-0010](0010-file-operation-engine-module.md) | File Operation Engine Module owns safe runtime/config file mutations | Superseded | [ADR-0009](0009-shell-command-projection-module.md) |
| [ADR-0010](0010-skill-surface-budget-module.md) | Skill Surface Budget Module owns install-time skill listing curation | Superseded | [ADR-0011](0011-skill-surface-budget-module.md) |
| [ADR-0011](0011-review-default-reviewers-prd.md) | PRD — `review.default_reviewers` config key for `/gsd-review` reviewer selection | Legacy | — |
| [ADR-0012](0012-command-routing-hub.md) | CommandRoutingHub as single dispatch seam for CJS command families | Superseded | [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) |
| [ADR-2264](2264-golden-parity-redesign.md) | Redesign golden-install-parity — single-source manifest builder + split invariant | Superseded | [ADR-2719](2719-emitted-artifact-attribution.md) |
| [ADR-3524](3524-cjs-sdk-hard-seam.md) | CJS↔SDK hard seam — one source of truth per Shared Module | Superseded | [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) |

_69 ADRs. Generated by `scripts/gen-adr-index.cjs` — run `--write` after adding or restatusing an ADR._

<!-- ADR-INDEX:END -->

## Seam map

Orientation for the module-ownership ADRs. This section is prose and hand-maintained; the index above is the authority on status.

**How GSD meets a host — start at [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (EoS).** It is the current frame and subsumes the descriptor/projection ADRs ([ADR-1016](1016-runtime-capability-descriptor.md), [ADR-58](58-runtime-install-policy-module.md), [ADR-3660](3660-runtime-artifact-layout-module.md), [ADR-894](894-capability-declaration-format.md)) as adapters beneath it.

**The SDK seam map is gone.** [ADR-0005](0005-sdk-architecture-seam-map.md) was once the entry point for SDK module ownership; it is **superseded by [ADR-0174](0174-retire-gsd-sdk-package-boundary.md)**, which retired the `@opengsd/gsd-sdk` package boundary entirely. There is no `sdk/` tree. Read ADR-0174 for the single-runtime collapse; the seam-Module vocabulary survives under one `src/`.

[ADR-0006](0006-planning-path-projection-module.md) documents how query handlers project planning paths (`cwd → effectiveRoot → .planning/<project>/...`). Cross-reference the Planning Workspace Module ([ADR-0004](0004-worktree-workstream-seam-module.md)) for workstream pointer policy.

[ADR-0008](0008-installer-migration-module.md) documents the Installer Migration Module for safe install-time moves, removals, config rewrites, and user-data preservation.

[ADR-0009](0009-shell-command-projection-module.md) documents the Shell Command Projection Module seam for runtime-aware projection of installer-owned command text and projection IR. Its Phases 3–4 absorbed the File Operation Engine Module ([ADR-0010](0010-file-operation-engine-module.md)).

[ADR-0011](0011-skill-surface-budget-module.md) documents the Skill Surface Budget Module for install-time skill/agent profile staging (`--profile=<name>`, `.gsd-profile` marker, `requires:` closure) and the Phase 2 runtime `/gsd:surface` command.

[ADR-1411](1411-resolution-provenance.md) establishes the Resolution Provenance principle: context resolution (config loading, project-root anchoring, workstream resolution) must report its provenance rather than fall open silently to defaults. It is the resolution-side analog of [ADR-227](227-input-validation-shape-not-just-type.md) (input-validation shape).

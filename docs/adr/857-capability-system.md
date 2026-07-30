# ADR-857: Capability system — five-step loop as core, features as plug-ins behind Loop Extension Points [Accepted]

- **Status:** Accepted — ratified 2026-07-17 (originally Proposed 2026-06-08); see "Ratification" below
- **Date:** 2026-06-08
- **Issue:** #857
- **Subsumes (generalizes):** Skill Surface Budget Module ([ADR-0011](0011-skill-surface-budget-module.md)), Runtime Install Policy Module ([ADR-58](58-runtime-install-policy-module.md)) — both remain **Accepted and live**; this ADR generalizes them, it does not replace them. See "Relation to ADR-0011 and ADR-58" below.
- **Builds on:** CommandRoutingHub (ADR-0012), Runtime Artifact Layout Module (ADR-3660), generated-cjs single source (ADR-457)
- **Amended:** 2026-06-12 — phase-6 boundary settled before the Migrate phase freezes it: the **verifier↔predicate contract** is classified as core verification substrate (not an off-by-default Feature Capability). See *Verification substrate vs. plug-in tier (the predicate boundary)* below. Prompted by @davesienkowski's boundary analysis on #857; coordinates with ADR-550 (spec-phase probe contract).
- **Decisions 7 and 8 are extended by** [ADR-1244](1244-capability-ecosystem.md) (Capability Ecosystem) — amend, not reverse. D7 deferred third-party code-loading "to its own ADR" and D8 deferred third-party CLI support to "an external loader + trust/validation gate"; ADR-1244 is that ADR and delivers that gate. *(This marker is required by ADR-1244 D8, which states ADR-857 "is updated to mark D7 and D8 'extended by ADR-1244'". The marker was never actually added; recorded here 2026-07-28 while amending this ADR for ADR-2782.)*
- **Amended by:** [ADR-2782](2782-reviewer-lane-capability-surface.md) (Reviewer Lane capability surface) — extends "extension points as data" to the cross-AI reviewer handoff: a reviewer lane becomes a declared capability body rather than a core patch.

## Ratification (2026-07-17): Proposed → Accepted

Ratified by maintainer directive. This ADR read `Proposed` for over a month while the capability system it decides **was the shipped architecture of 1.6.0/1.7.0** — a label that invited contributors and agents to treat the live plug-in architecture as an unbuilt idea.

**Evidence the decision shipped** (each item verified against the tree, then independently re-verified by two reviewers instructed to refute this ratification; neither could):

- **The lifecycle exists.** `src/capability-lifecycle.cts:880-1053` implements `installCapability`, plus `upgradeCapability` / `removeCapability` / `bindProjectConsent`. `src/capability-state.cts` resolves capability state; `gsd-core/bin/lib/capability-validator.cjs` validates descriptors; `scripts/gen-capability-registry.cjs` generates the registry into `gsd-core/bin/lib/capability-registry.cjs`.
- **The plug-in split is real, not notional.** `capabilities/` holds 30+ descriptors spanning `role: feature` (research, ui, security, code-review, graphify, intel, audit, profile-pipeline, tdd, schema-gate, drift, gap-analysis, nyquist, pattern-mapper, ai-integration, mempalace, assumption-delta, external-job) and `role: runtime` (claude, codex, antigravity, cline, cursor, windsurf, kilo, qwen, hermes, pi, trae, augment, copilot, codebuddy, opencode, vscode).
- **The god-module is gone.** `src/core.cts` — the 2271-line module named in this ADR's Context — no longer exists; it decomposed into `io.cts`, `config-loader.cts`, `phase-locator.cts`, `model-resolver.cts`, `roadmap-parser.cts`. Epic #1267 ("retire the core.cjs re-export spine") is closed. Corroborated independently at [`612-bracket-phase-id-convention.md`](612-bracket-phase-id-convention.md):165 ("core.cts no longer exists").
- **The Loop Extension Points are wired.** All 12 named points (`discuss:pre/post`, `plan:pre/post`, `execute:pre`, `execute:wave:pre/post`, `execute:post`, `verify:pre/post`, `ship:pre/post`) have live render-hook call sites in the host loop.
- **The workflow bodies shrank, as this ADR's Consequences promised.** `plan-phase.md` is 93,959 bytes against a frozen pre-phase-6 ceiling of 94,519; `execute-phase.md` is 93,363 against 93,600.
- **Tests exercise it.** 16 dedicated `tests/capability-*.test.cjs` files (largest: `capability-registry.test.cjs` at 297K, `capability-lifecycle.test.cjs` at 184K), plus `tests/phase6-capstone-conformance.test.cjs`, whose three assertions are marked "RED BY DESIGN until phase 6 is actually complete" — added after #1139 was caught closing green on a false completion — and all three pass.
- **Governance closed.** Epic [#857](https://github.com/open-gsd/gsd-core/issues/857) is CLOSED with `stateReason=COMPLETED` (2026-06-14). All six rollout-phase sub-issue clusters are CLOSED/COMPLETED: #870/#885 (phases 1–2), #894/#896/#903/#910/#918 (phase 3), #942/#945/#959/#961/#1136/#1138/#1213 (phase 4), #1016/#1035/#1056/#1077 (phase 5), #1120/#1135/#1137/#1139/#1820 (phase 6).
- **The corpus already treats it as live.** 20+ later ADRs (894, 959, 1016, 1056, 1077, 1143, 1213, 1239, 1244, 1372, 1593, 1606, 1671, 1769, 1817, 1820, 550, 58, 612) build on this ADR's capability model as current architecture; none claims to replace it. [`1244-capability-ecosystem.md`](1244-capability-ecosystem.md):12, authored independently, states: "32 capabilities ship today (20 `role:feature`, 12 `role:runtime`). The architecture is in place."

### Relation to ADR-0011 and ADR-58 — generalized, not replaced

This ADR's header field originally read "**Supersedes** (generalizes)". On ratification that wording was corrected to **Subsumes**, because taking "supersedes" literally would have stamped two live decisions as dead:

- [ADR-0011](0011-skill-surface-budget-module.md)'s Skill Surface Budget Module is live — `applySurface` at `src/surface.cts:348`.
- [ADR-58](58-runtime-install-policy-module.md)'s typed `InstallPlan` seam is live — `src/runtime-artifact-install-plan.cts:82`.

Both keep `Accepted` status and now carry a `Subsumed by` pointer here. The parenthetical "(generalizes)" was always the accurate word; only the field name was wrong.

### What this ratification does not settle

[ADR-959](959-capability-command-contribution.md) (command contribution) stays `Proposed`: issue [#2346](https://github.com/open-gsd/gsd-core/issues/2346) — "ADR: Command Dispatch Completion" — is OPEN and maintainer-approved, and explicitly plans 959's graduation as its own capstone ADR. Ratifying it here would preempt that.

See also [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (EoS, Accepted), which realizes and **inverts** this ADR's Decision 8 — flipping *projection* to *embedding*. For how GSD meets a host, EoS is the current frame.

## Context

GSD has no real line between **the loop** and **a feature**. The five-step loop — Discuss → Plan → Execute → Verify → Ship — is the product, but its workflow bodies have absorbed every optional feature as inline `if config.X` branches:

- `gsd-core/workflows/plan-phase.md` is **1814 lines**; `execute-phase.md` is **1752 lines**. AI-spec (§4.5), research (§5), nyquist (§5.5), security threat-model (§5.55), UI-spec (§5.6), schema gate (§5.7), pattern-mapper (§7.8), intel (§7.9), code-review, and the planner/checker loop are all welded in at fixed `§`-points. The activation check and the behaviour live in the same file.
- "Is feature X on?" has **three independent, non-communicating answers**: `.gsd-profile` (installed?), `.gsd-surface.json` (surfaced?), and `.planning/config.json` `workflow.*` (gated?). `workflow.ui_phase=false` still leaves `ui-phase` fully surfaced.
- Adding or removing one feature is a **7-file registration tax**: `clusters.cts`, `install-profiles.cts`, `config-schema.manifest.json`, `CODEX_AGENT_SANDBOX` in `bin/install.js`, `command-aliases.cts`, agent prose, and the `.md` files.
- `src/core.cts` (2271 lines) is a god-module imported by 24 files; four otherwise-detachable feature modules (`graphify`, `intel`, `audit`, `profile-pipeline`) are tied to it **solely** for `output()`/`error()`.

Consequence: a minimal GSD is not really installable, optional features sit inside the core loop's reliability surface, and the codebase is hard for humans and AI agents to navigate or change.

The healthier news from the architecture review: the lower seams are already in good shape. `CommandRoutingHub` is data-driven; `runtime-artifact-layout` is one localized table; the `init.*` query already resolves a per-step JSON bundle; the repo already generates manifests from co-located sources (`research-profiles.cjs`, `package-identity.cjs`). The target is reachable without re-litigating those.

## Decision

Introduce a **Capability** system. The five-step loop plus shared-infrastructure skills (`phase`, `config`, `help`, `update`, `surface`, `progress`) are the **privileged host/core**. Every other feature is a **Capability** — a plug-in selectable at install and toggleable after restart. **One settled exception** (2026-06-12): the verifier↔predicate contract is **core verification substrate**, not a Capability — the predicates that set the verifier's reach cannot live in an off-by-default plug-in. See *Verification substrate vs. plug-in tier (the predicate boundary)*.

The design was resolved across seven decisions:

1. **Model — host now, kernel later.** The loop is a privileged host that exposes a defined set of extension points; Capabilities attach. The host is never uninstalled. **Constraint carried through every other decision:** extension points are expressed as *data*, not hardcoded control flow, and each loop step is authored as if it could itself become a Capability — so a later migration to a uniform kernel (steps-as-capabilities) does not break plug-ins.

2. **Granularity — feature bundle.** One Capability owns N skills + M agents + hooks + a federated config-key schema + loop-extension registrations, plus a `requires` list of other Capabilities. It toggles as a unit. This matches `clusters.cts` (richer: it also owns agents, config, and loop participation) and is kernel-compatible — a loop step is also a bundle.

3. **Manifest — co-located → generated; config federated.** Each Capability self-declares in its own folder; a build step compiles all declarations into a generated central **Capability Registry** (mirroring the existing co-located-source → generated-file pattern). This kills the registration tax while preserving a central artifact for runtime resolution and validation. **Config schema is federated:** each Capability ships its own config-key slice (keys, defaults, validation); the loader merges them defensively. Uninstalling a Capability removes its config keys cleanly; a malformed plug-in cannot break config load for the whole tool.

4. **Extension points — three hook kinds, coarse stable set.** ~12 named **Loop Extension Points** (per-step `pre`/`post` plus per-wave in Execute) form a stable cross-version contract. Capabilities register hooks of three kinds: `step` (runs as its own sequenced unit), `contribution` (injects into the core step's prompt/context), and `gate` (checks and optionally blocks). All three are required: without `contribution`, prompt-woven features (security threat-model, TDD, schema gate) could never leave the core.

5. **Dispatch — runtime resolution with concrete projection.** Workflows do not embed a generic "run whatever's registered" instruction (which would erode the executor's narrative reliability), nor are workflow files rewritten at install. Instead the workflow calls a query — extending the existing `init.*` resolution seam (e.g. `loop.render-hooks <point>`) — that resolves the active hooks and returns **fully-rendered, ordered markdown**. Toggling stays pure data (restart-and-go, kernel-friendly); the executor still receives concrete prose.

6. **Contract — derived order, file-artifact data flow, default-resilient failure.** Each hook declares the artifacts it `produces` and `consumes`. Hook order is the topological sort of that graph (capability-id tiebreak), which **also** defines data flow: file-artifact based (`RESEARCH.md`, `UI-SPEC.md`, …), surviving `/clear` and fresh 200k executor contexts. Failure is default-resilient — a non-gate hook that errors is skipped with a warning so a bad plug-in cannot brick the core loop; a hook may opt into `onError: halt`; `gate` hooks declare `blocking: true|false` (mirroring today's `security.block_on`).

7. **Code — declarative + first-party, third-party deferred.** Capabilities ship declarative artifacts (skills, agents, workflow-fragments, federated config, lifecycle hooks) now. In-tree code modules (`graphify`, `intel`, `audit`) become Capabilities by registering their query family through an opened `gsd-tools.cjs` entrypoint (registry over the current hardcoded switch). The manifest reserves a `commands`/`module` field. **Third-party code-loading is explicitly out of scope** — it carries a trust/load/build/security surface that deserves its own ADR.

8. **Runtime/CLI support is itself a Capability (declarative, tiered, third-party-ready).** The host-CLI integration (Claude Code, Codex, Antigravity, …) becomes a **Runtime Capability** — a `role: runtime` variant of the unified Capability concept (a Capability now carries `role: feature | runtime`). A Feature Capability *produces* artifacts (skills/agents/hooks/commands); a Runtime Capability *projects* them onto one CLI's conventions; install composes active Feature Capabilities × the chosen Runtime Capability at the **InstallPlan** seam (ADR-0058). A Runtime Capability is a **declarative descriptor over a fixed vocabulary of projection primitives** (config-surface format, artifact-layout kinds, command template, hooks manifest, sandbox tier) — not a code adapter. The shipped primitive library is first-party code; a CLI needing a novel primitive needs a first-party primitive — branch 7's "declarative + first-party code" rule applied to runtimes. **Anti-rework discipline:** first-party runtimes are authored through the *same descriptor a third party would write* (dogfooding the interface), so third-party support never requires re-authoring the runtimes. **Launch scope:** the descriptor seam, the primitive library, and all 15 existing runtimes re-authored as descriptors ship; the registry loads **in-tree descriptors only**. **Third-party CLI support is deferred to a purely additive external loader + trust/validation gate** — no rework, because runtimes are already descriptors. **Tiering:** Claude Code / Codex / Antigravity are tier-1 (fully tested); the other 12 existing runtimes ship as first-party lower-tier; none are dropped.

New domain terms recorded in `CONTEXT.md`: **Capability**, **Capability Registry**, **Loop Extension Point**.

## Resolved design details

These were grilled to resolution after the initial eight decisions.

### Loop Extension Points (the 12)

`discuss:pre`, `discuss:post`, `plan:pre`, `plan:post`, `execute:pre`, `execute:wave:pre`, `execute:wave:post`, `execute:post`, `verify:pre`, `verify:post`, `ship:pre`, `ship:post`. The planner/checker loop, the verifier, the verify-work gap-closure loop, **and the verifier↔predicate contract** (the spec-reach substrate — see *Verification substrate vs. plug-in tier* below) remain **core** (not hooks). Today's `§`-point features map on as: research / ui-spec / ai-spec / pattern-mapper (`step`) and security / schema-gate / tdd (`contribution`) and drift (`gate`) at `plan:pre`; nyquist / gap-analysis (`gate`) at `plan:post`; build+test / code-review / drift (`gate`/`step`) at `execute:wave:post`; `verification.status` preflight (`gate`) at `ship:pre`; PR-body sections (`contribution`) at `ship:post`. The names are a stability contract — additive-only across versions.

### Verification substrate vs. plug-in tier (the predicate boundary)

Settled before phase 6 (Migrate) freezes the core/plug-in line. **The probe family that generates must-NOT-have and edge predicates is core verification substrate, not an off-by-default Feature Capability** — split into a non-toggleable contract and a core-default generator.

**The load-bearing finding:** *verifier reach = spec reach.* The verifier can only catch what the spec concretely names; the must-NOT-have / edge predicates **are** the reach of the spec the verifier verifies. Placing the verifier in core (already exempted above) while leaving the input that sets its reach in an off-by-default Capability would make the core's reliability a function of an optional plug-in — the exact blast-radius leak decision #6 exists to prevent. (The live case: prose-drift and a self-graded review rationalizing a defect away — both reproduced on #664 — are why grading must be **exogenous**, i.e. against externally-supplied predicates rather than the verifier's own restated understanding.)

**Altitude rule (where the line falls).** A `gate` runs *against* the spec at a point and may block (hook). Predicate-generation defines *what the verifier is allowed to see* — it is upstream of and constitutive of verification, not a check within it. So: **gates run against the spec (hook); predicate-generation defines the spec's reach (core).** This is why nyquist / gap-analysis remain `gate` hooks while the predicate contract does not.

**Decomposition** (keeps the fallible part out of the core blast radius without making "off" silently shrink the verifier's reach):

- **Core, non-negotiable — the contract.** The verifier always expects must-NOT-have predicates and grades **exogenously** against them. This substrate is **not toggleable**; no `capabilities/edge-probe/` Feature Capability may remove it. The decision-#6 `produces`/`consumes` wire is the **internal rail** from predicate-generation to the core verifier (file-artifact data flow surviving `/clear`), not a Loop Extension Point a plug-in can detach. The contract is a **stability contract** alongside the Loop Extension Point names (Hyrum's Law: once relied on, it is a depended-upon interface — name it and keep it compatible).
- **Core-default but independently versionable — the generator.** The **probe adapters** — the taxonomy + classifier that *propose* predicates (edge-probe's `classifyShape`/`proposeEdges`, the prohibition probe's adversarial LLM-propose), governed by ADR-550 — are the generator. They keep their own module precisely because the classifier has a measured recall gap (the prose→shape classifier under-fires on terse prose without erroring) and must keep improving without churning the contract. The generator is **default-on and non-removable**, but versioned separately (Gall's Law: the minimal core rail evolves slowly; the complex fallible generator evolves on its own cadence). Its fallibility is contained the same way the federated-config merge is — a generator miss is a recall gap to improve, never a core-load break. (Note: ADR-550's `probe-core` deterministic resolution/validation engine is *not* the generator — per Decision 7b it ingests already-proposed items; its validators are the **contract**'s CI-testable surface, Decision 5.)

The ownership seam is clean (Conway's Law): the **contract** is owned by the core verifier plus `probe-core`'s deterministic validation/rollup engine; the **generator** is owned by the probe adapters; the `produces`/`consumes` artifact rail (decision #6) joins them. Consequently, **phase 6 does not migrate predicate-generation to an off-by-default Capability** — it wires the existing edge-probe/prohibition-probe modules onto the core predicate rail as core-default substrate. (Attribution: boundary analysis by @davesienkowski on #857, accepted by the maintainer; cross-referenced from ADR-550.)

### Contribution merge

Multiple `contribution` hooks at one point compose by ordered concatenation in the same `produces`/`consumes` topological order (capability-id tiebreak), each wrapped in a labeled block `<contribution from="<capability-id>">…</contribution>`. Provenance is explicit; semantic conflicts stay visible (both blocks render) rather than silently resolved — acceptable because the maintainer controls the active set.

### Capability declaration shape

A Capability is a folder `capabilities/<id>/` with a schema-validated data manifest `capability.json`. The manifest **explicitly lists** every owned artifact (skills, agents, hooks) plus the non-file facts (`role: feature | runtime`, `requires`, loop-hook registrations, config-schema ref, `runtimeCompat`, `tier`); ownership is validated against folder contents. Owned artifacts live co-located in the folder; genuinely shared artifacts (e.g. `gsd-planner`) live in a core home and are referenced. Co-located manifests compile to the generated central CJS Capability Registry.

### Runtime Capability descriptor

A closed named-primitive vocabulary over six axes: `configHome` (config dir), `configFormat` (`settings-json | toml | markdown | markdown-dir | none`), `artifact-layout` (destSubpath + prefix per artifact kind), `command-style`, `hooks-surface` (`settings-block | hooks-json`), and `sandbox-tier`. A descriptor selects named primitives + data; it carries no free templates or code. Adding a primitive (e.g. a novel config serializer) is first-party code plus a new enum value — branch 7's rule. This keeps descriptors inherently safe and third-party-authorable.

### Deferred third-party trust gate

Made light by the closed vocabulary: (1) validate the descriptor against its JSON-schema; (2) confine all file writes under the runtime's declared `configHome`; (3) require explicit user opt-in to trust an external runtime id. No code execution or free templates means no sandbox is required — the gate is purely additive to the launch design.

## Alternatives considered

| Decision | Rejected alternative | Why rejected |
|---|---|---|
| Model | Uniform kernel now (steps are capabilities) | Dissolves the loop narrative LLM-parsed workflows depend on; kept reachable via "host now, kernel later" |
| Granularity | Per-skill + `requires` closure | Pushes the dependency graph onto users; breaks uniformity with how a loop step looks |
| Granularity | Two-tier (skills grouped into bundles) | Two concepts to keep coherent; bundle alone suffices for v1 |
| Manifest | Central hand-edited registry | Only shrinks the tax (~7→2 files); plug-ins can't self-register |
| Manifest | Co-located only (live scan, no generated file) | No single artifact for cross-capability invariants/validation |
| Config | Central (non-federated) schema | Disabled/uninstalled feature keys linger in one file |
| Points | Sequence-steps only | Security/TDD/schema stay welded into the planner prompt |
| Points | Step + gate (no contribution) | Same — prompt-injected features can't become plug-ins |
| Dispatch | Static expansion at install | Toggling needs re-staging; installed workflows become un-editable generated artifacts; runs per-runtime |
| Dispatch | Generic runtime resolution | Executor follows a generic instruction; loses per-feature narrative reliability |
| Failure | Strict (any hook error halts) | One malformed optional plug-in could brick the core loop |
| Code | Full third-party code-shipping now | Pulls the trust/load/security surface in prematurely |
| Runtime concept | Two distinct Feature/Runtime concepts | One role-typed Capability keeps a single registry and mental model |
| Runtime interface | Code adapter, third-party loadable | Ships the trust/load/security surface prematurely; not needed at launch |
| Runtime interface | Code adapter, first-party only | Forces a later retrofit to a descriptor format — the exact rework ADR-857 is unwinding for features |
| Runtime scope | Drop the 12 non-tier-1 runtimes | Regresses working runtime support for current users |
| Predicate boundary | Predicate-generation as an off-by-default `capabilities/edge-probe/` Feature Capability | Makes the core verifier's reach (and thus its reliability) a function of an optional plug-in — the blast-radius leak decision #6 forbids; *verifier reach = spec reach* |
| Predicate boundary | Promote the whole probe (taxonomy + classifier) into core wholesale | The classifier has a measured recall gap and must keep improving; folding it into the slow core rail grows core complexity and couples contract churn to generator iteration (Gall's Law) — decompose into core contract + core-default generator instead |

## Consequences

**Positive**

- **Locality:** one declaration per feature replaces a 7-file edit tax; a feature's skills, agents, hooks, and config keys live and leave together.
- **Leverage:** install, surface, config gating, and loop participation all become adapters over one Capability declaration.
- The core loop ships and runs **without any plug-in**; `plan-phase.md`/`execute-phase.md` shrink to the irreducible five steps.
- One resolved capability state replaces three contradicting toggle systems; "off" means off.
- `core.cts`'s blast radius shrinks; four feature modules drop to zero planning-layer coupling once `io.cts` is extracted.
- AI-navigability improves: the loop is a short legible spine, features are self-contained modules.
- The runtime/install layer becomes symmetric with the feature layer; ADR-0058's adapter registry is finished as a contributable descriptor seam, and third-party CLI support becomes additive rather than a rework.

**Negative / costs**

- New always-on machinery to build and keep correct: Capability Registry generation, federated-config defensive merge, and the `loop.render-hooks` resolver/projection.
- The Loop Extension Point set becomes a **stability contract** — point names must stay compatible across versions or plug-ins break.
- Default-resilient failure trades a small "silent skip" risk for core protection; gates and `onError: halt` must be authored deliberately where a feature is genuinely required.
- A multi-phase migration on a fast-moving `next`; each step must keep the tree green.
- A projection-primitive vocabulary must be designed to cover real CLIs without leaking implementation detail; tiering implies a documented support-tier policy and (ideally) a cross-runtime test matrix.

## Rollout

Phased; `next` stays green at each step. (Maps to the candidate sequence from the architecture review.)

1. **Enable** — extract `output()`/`error()` from `core.cts` into `src/io.cts`; repoint `graphify`/`intel`/`audit`/`profile-pipeline`. Cheap, reversible.
2. **Clear ground** — decompose `core.cts` into `io.cts`, `config-loader.cts`, `phase-locator.cts`, `model-resolver.cts`, `roadmap-parser.cts` (ends the roadmap-parse-in-core split). Re-export shims ease transition.
3. **Define** — land the Capability Registry generation, the federated config loader, and the Loop Extension Point resolver (`loop.render-hooks`, extending `init.*`). Define the ~12 stable points.
4. **Wire** — collapse `.gsd-profile` + `.gsd-surface.json` + `config.json workflow.*` into one resolved capability state; open the `gsd-tools.cjs:runCommand` entrypoint (registry) so first-party code modules register as Capabilities.
5. **Runtime seam** — finish the InstallPlan adapter registry (ADR-0058) as a declarative descriptor over a primitive vocabulary; re-author the 15 runtimes as descriptors (tier-1: Claude/Codex/Antigravity); registry loads in-tree descriptors only (third-party loader deferred).
6. **Migrate** — convert existing optional features (UI, AI/eval, research, security, nyquist, code-review, graphify, …) to Capabilities; shrink the loop workflow bodies. **Exception (settled 2026-06-12):** the edge-probe / prohibition-probe predicate-generation (ADR-550) is **not** migrated to an off-by-default Feature Capability — the verifier↔predicate contract is core substrate and the generator is a core-default module (see *Verification substrate vs. plug-in tier*). Phase 6 wires these modules onto the core predicate rail rather than relabeling them as plug-ins. (#999's Impeccable migration is unaffected — it is a genuine Feature Capability.)

Each phase is its own `approved-*` issue under #857 (an approved epic does not approve its children).

## Open questions

- Migration ordering among features with cross-dependencies (e.g. UI-spec → plan, code-review → execute) under the default-resilient failure model.
- Whether tier-1 (Claude Code / Codex / Antigravity) implies an automated cross-runtime test matrix as a merge gate.
- ~~Whether predicate-generation (edge/prohibition probes) is core substrate or a Feature Capability~~ — **resolved 2026-06-12**: core substrate (contract) + core-default generator; not an off-by-default Capability. See *Verification substrate vs. plug-in tier*.
- Whether the verifier↔predicate **contract** warrants a deterministic CI conformance test (a core-default generator producing a contract-shaped predicate set the verifier consumes), extending ADR-550 Decision 5's "test the contract, not the classifier" rule to the core rail — likely yes; deferred to the phase-3/phase-6 implementation issue.

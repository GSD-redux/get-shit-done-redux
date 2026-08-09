# ADR-2866: Install-surface resolution — the install pipeline resolves `(runtime × scope × trigger)` as a value

- **Status:** Accepted
- **Date:** 2026-08-09
- **Issue:** [#2866](https://github.com/open-gsd/gsd-core/issues/2866) (epic); Phase 0 tracked by [#2869](https://github.com/open-gsd/gsd-core/issues/2869)
- **Amends:** [ADR-3660](3660-runtime-artifact-layout-module.md) (widens the Runtime Artifact Layout Module from placement-only to placement **+** trigger resolution) and [ADR-1016](1016-runtime-capability-descriptor.md) (adds one axis — host trigger precedence — to its closed descriptor vocabulary). Neither is superseded; both remain `Accepted` and live, and both carry the reciprocal `Amended by` field. The decision is recorded now; the modules change at Phase 2 — see [Reciprocal amendment notes](#reciprocal-amendment-notes).
- **Relationship to prior work:** *completes* [ADR-58](58-runtime-install-policy-module.md) rather than revising it (its rollout's cleanup step never landed); preserves [ADR-1508](1508-runtime-artifact-conversion-module.md)'s dependency direction (installer/layout → conversion, never upward); Phase 3's manifest schema bump is [ADR-0008](0008-installer-migration-module.md) territory; Phase 2's schema change is additive-with-default per [ADR-894](894-capability-declaration-format.md). Like the adapters it touches, this ADR sits **beneath** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (EoS) — it widens one negotiated surface of the Host-Integration Interface; it does not re-answer how GSD meets a host.

## Context

[#2218](https://github.com/open-gsd/gsd-core/issues/2218) is the presenting defect: a user who installs the Claude runtime at **both** scopes — `--claude --global` and `--claude --local` — silently loses 100% of the project-local `/gsd-*` surface. It is "every time — 100% reproducible", the reporter's impact assessment is "major — core feature is broken, no workaround", and its triage stalled at `ready-for-human` because every proposed remediation read as a product decision bolted onto the installer.

It stalled for a deeper reason. **The codebase cannot state the problem.**

### The trigger namespace is modeled nowhere

[ADR-3660](3660-runtime-artifact-layout-module.md) answers exactly one question — *given this artifact kind and this runtime, where does the file go?* — and stops. That narrowness was deliberate and, at the time, correct: [ADR-1508](1508-runtime-artifact-conversion-module.md) draws the sibling line in one sentence, "Layout owns placement; this module owns content."

The seam has since gained a `scope` parameter — `resolveRuntimeArtifactLayout(runtime, configDir, scope: 'local' | 'global' = 'global', capabilityRegistry?)` — but placement-only is a property of the **returned value**, not of the parameter list. `Layout` is `{ runtime, configDir, scope?, kinds: ArtifactKind[] }` and `ArtifactKind` is `{ kind, destSubpath, prefix, stage, home?, converter? }`. Neither carries a trigger.

That absence is the defect. Both the `skills` and `commands` kinds derive their stems from the same `commands/gsd/*.md` sources, so a Claude user with both installs gets two artifacts resolving to one `/gsd-<name>` trigger. The host resolves **skill over command** *and* **personal over project**, so the project-local tree becomes unreachable. No module and no test can name the collision, because it is an absence rather than a value.

All 19 runtime descriptors declaring `artifactLayout`, partitioned exhaustively:

| Count | Descriptors | Shape | Shadowing behavior |
|---|---|---|---|
| 12 | `antigravity`, `augment`, `codebuddy`, `codex`, `copilot`, `cursor`, `hermes`, `kilo`, `opencode`, `qwen`, `trae`, `zcode` | `skills` at **both** scopes | Same mechanic, identical kind — the personal copy wins and points at a tree that exists. A **loud override**, not silent loss. |
| 1 | `claude` | `global=[skills]`, `local=[commands, agents]` — the only runtime whose scopes emit **disjoint** trigger-bearing kinds | The whole local surface vanishes rather than merely being overridden. **This is #2218.** |
| 1 | `windsurf` | `global=[agents]`, `local=[commands, agents]` — also scope-asymmetric | Its global scope emits **no command trigger**, so nothing collides. Does **not** exhibit #2218's failure. |
| 3 | `cline`, `kimi`, `kimi-code` | `global=[…]`, `local=[]` | No local emission at all, so no cross-scope collision is reachable. |
| 2 | `pi`, `vscode` | `global=[]`, `local=[]` | No GSD artifact surface. |
| **0** | — | modules that model the trigger namespace or cross-scope precedence | **This is the absence the epic exists to fix.** |

**The mechanism is general; the failure is specific to `claude`** — and the partition above is the reason: only `claude` combines a trigger-bearing global kind with a *disjoint* trigger-bearing local kind.

### Scope is a bare string re-derived at every layer

`bin/install.js` contains 12 literal `isGlobal ? 'global' : 'local'` sites; the boolean is then reconstructed downstream in `runtime-artifact-layout.cts`, `runtime-artifact-install-plan.cts` and `surface.cts`. There is no shared resolver — `runtime-homes.cts`'s `resolveConfigHomeFromDescriptor` takes no `scope` parameter at all, and the one partial projection that exists (`hostBehaviors.settingsFileByScope`) has a single consumer inside `bin/install.js` with a hardcoded fallback, so no other module can reach it.

The concept also has three incompatible spellings in `src/` alone:

| Site | Representation |
|---|---|
| `src/runtime-artifact-layout.cts` | `scope?: 'local' \| 'global'` |
| `src/capability-lifecycle.cts` | `scope?: 'global' \| 'project'` |
| `src/capability-consent.cts` | `ConsentRecord.scope: 'project'` — a single literal; global is encoded as *absence* |

Nothing can answer "what is installed, where": `gsd-file-manifest.json` records `{version, timestamp, mode, files}` with **no `scope` and no `runtime` field**, and global and local installs write two manifests to two directories that are never merged and never cross-read.

### The consequence

Every remediation proposed for #2218 reads as a special case, because no module owns the concept that would carry the fix — and, as recorded below, two of the three proposed remediations turn out not to work at all.

## Decision

**The install pipeline resolves *surface identity* — `(runtime × scope × trigger)` — as a value, instead of implying it from destination paths.**

Concretely: the Runtime Artifact Layout Module returns resolved **triggers**, not only placements, with host precedence declared as a descriptor axis; scope becomes one resolved value produced by one module rather than a string re-interpreted in seven places; and the install manifest records `scope` and `runtime` so an Installed Surface Resolver can answer *"which surfaces are installed, at which scopes, for which runtimes — and is one shadowing another?"* #2218's shadowing then becomes a field on a returned value rather than an invisible outcome of host resolution.

The four sections below record what that costs the ADRs it touches. Everything else — the phase map, the consequences, the rejected alternatives — follows from them.

### 1. Amendment to ADR-3660: placement-only stopped paying

[ADR-3660](3660-runtime-artifact-layout-module.md) is **amended, not superseded.** Its placement decision is correct and load-bearing: 19 descriptors and three consumers depend on it, and its `Consequences` — a new runtime is one table row, and out-of-seam placement knowledge is drift — remain in force.

**What changes:** the module widens from *placement* to *placement + trigger resolution*. It gains a projection returning, per emitted artifact, the `/gsd-<name>` trigger it will occupy, the kind and scope that produced it, its destination, and whether another install shadows it. `resolveRuntimeArtifactLayout` stays for callers that only need placement, so no existing consumer is forced to move.

**Why the narrowness stopped paying — stated so a future reader does not re-narrow it.** ADR-3660's scope was right for the question it was built for (#3659: `applySurface` failed to prune skill directories — a pure *placement* omission, and the layout table fixed it). It stops paying at the first question whose answer is not a path. #2218 is that question. The colliding `/gsd-<name>` trigger is not a value anywhere in the tree, so no module can express the collision, no test can assert it, and no error message can name it. A seam that cannot state a defect in its own domain has drawn its boundary one concept too small. Placement is *where the file goes*; the trigger is *what the user types* — and it is the second one the host arbitrates.

**This does not absorb historical kinds.** Legacy-layout migrations stay in the Installer Migration Module ([ADR-0008](0008-installer-migration-module.md)) and continue to run before layout-driven copy, exactly as ADR-3660 decided. The layout module still describes only the current canonical target.

### 2. One axis added to ADR-1016's closed descriptor vocabulary: host trigger precedence

[ADR-1016](1016-runtime-capability-descriptor.md) designs the runtime descriptor's vocabulary as **closed on purpose** — a new axis is intentional friction requiring review, so that "add a runtime" stays "author one `capability.json`" instead of "teach N modules what this runtime means". **This ADR is that review, and it approves exactly one axis: host trigger precedence.**

**Why it must be a descriptor axis rather than code.** Precedence is a fact about the *host*, not about GSD: Claude resolves skill-over-command and personal-over-project; another host may do neither. Encoding it in a module means a per-runtime `if` — the precise drift ADR-3660's table exists to prevent and ADR-1016's descriptor exists to prevent. It belongs where every other host fact already lives.

**Why one and not two.** Scope's own precedence rank is a property of a *scope*, not of a *placement*, and it is produced by the Install Scope Module (Phase 1). Only the host's kind-level trigger arbitration is genuinely descriptor-shaped. Widening the vocabulary by two axes when one is enough would spend ADR-1016's friction budget on the wrong thing.

**Compatibility.** The axis is **required-with-default**: third-party runtime capabilities authored against today's schema keep working unchanged, which keeps the change additive-only per [ADR-894](894-capability-declaration-format.md)'s stability contract. The registry generator and the validator must be updated in the same change as the schema — a descriptor field the validator does not know is a field third-party authors cannot rely on.

### 3. The `@`-include constraint — and why #2218 triage option 1 is refuted

**The constraint, recorded here as a first-class design fact:** markdown `@`-includes expand `~` but do **not** expand environment variables, and no conditional-include syntax exists. It is currently written down only as a comment on a SessionStart hook (`hooks/gsd-ensure-canonical-path.js`), framed as a marketplace-plugin problem — so nothing tells a contributor it also constrains *spec-root emission*. Whatever literal string is baked into an `@…` is what the host statically resolves; there is no cwd-conditional spec resolution anywhere in the emitted surface today.

This is the hard constraint on any #2218 fix, and it decides two of the three remediations that #2218's triage proposed:

- **Triage option 1 — "make `--local` also emit a skill" — is REFUTED, not deprioritized.** The host rule is *personal overrides project* for identically-named skills. Emitting a project-scope skill changes **which artifact wins**; it does not change **what the winning artifact points at**. The local spec tree stays exactly as unreachable as before. Recorded here so it is not re-proposed — it is the intuitive fix, and its failure is not visible from the symptom.
- **Triage option 3 — "document scope mutual-exclusivity" — is rejected as a fix.** The reporter's configuration (per-project customizations plus a global install for projects without one) is legitimate; documenting it away removes a working configuration rather than supporting it. It is retained **only** as the fallback if the Phase 4b mechanism is rejected, in which case the limitation must be documented explicitly rather than left implicit.
- **Triage option 2 — detect and warn — is necessary but not sufficient.** It removes the *silence*, which is #2218's worst property, but leaves the user unable to actually use both installs.

**Therefore the only lever is what the winning artifact points at.** That is why Phase 4 splits into an unconditional detection floor and a separately-signed-off behavioral fix — see [What this ADR does not decide](#what-this-adr-does-not-decide).

### 4. Non-conflicts: completes ADR-58, preserves ADR-1508's direction

**[ADR-58](58-runtime-install-policy-module.md) is completed, not revised.** Its decision — install logic testable as pure data, resolution free of IO, thin adapters executing — is unchanged and still right. Its rollout sequenced *registry → adapter → helpers → cleanup*, and the cleanup step never landed: `installRuntimeArtifacts()` still returns `void`, so install's correctness is observable only by re-reading disk. The counter-example is already in the tree — `createRuntimeArtifactInstallPlan()` returns a pure `{ok, plan}` its test asserts in one comparison with injected stage dependencies and no real filesystem. Phase 5 finishes the sequence ADR-58 wrote. Nothing in ADR-58 is reopened.

**[ADR-1508](1508-runtime-artifact-conversion-module.md)'s dependency direction is preserved: installer/layout → conversion, never upward.** No phase makes `src/` depend on `bin/install.js`. Phase 6's Layout Materializer is extracted *from* the installer *into* `src/`, with `bin/install.js` as a caller — the same direction ADR-1508 established. `bin/install.js` remains hand-authored JS, as ADR-1508 explicitly decided ("Only the moved functions become TypeScript; `install.js` itself is not converted"), which is also why this PR corrects `CONTEXT.md`'s stale "(generated)" annotation for that file.

## What this ADR does not decide

Recorded explicitly, because an ADR that quietly ratifies these would be laundering decisions no one made.

- **Phase 4b's mechanism is NOT decided here.** Making the project-local spec tree reachable requires changing what the winning artifact points at. The epic's recommendation — for the Claude runtime only, emit the **spec-root reference only** as a two-step imperative resolution (prefer `<cwd>/.claude/gsd-core/…`, fall back to `~/.claude/gsd-core/…`) instead of a single static `@`-include — is recorded as **recommended, pending explicit maintainer sign-off**, with its tradeoff stated plainly: an `@`-include is pre-expanded by the host and is *guaranteed inclusion*; a resolved reference costs the agent one read and is *instruction-following*. That is a genuinely weaker promise, and scoping it to the spec-root reference alone (every other `@`-include stays static) is what makes it acceptable rather than what makes it equivalent. If the tradeoff is rejected, Phase 4a still ships and #2218 downgrades from "broken silently" to "unsupported loudly" — which must then be documented per option 3 above.
- **The trigger-resolution interface is not specified here.** `{trigger, kind, scope, destPath, shadowedBy}` is a sketch. Phase 2 ([#2871](https://github.com/open-gsd/gsd-core/issues/2871)) settles the shape. This ADR decides *that* the layout module resolves triggers, not its signature.
- **Phase 6's Layout Materializer is a new module and therefore owes its own ADR.** It is not decided here; folding a second module decision into this file would violate CONTRIBUTING's "one issue = one ADR-or-PRD = one PR".
- **The `local`/`project` spelling is not chosen here.** Phase 1 reconciles the three-way split and records the chosen spelling in `CONTEXT.md`'s glossary, which is where domain vocabulary is owned.
- **`hostIntegration.embeddingMode: "imperative"` is unrelated to any of this.** Per `docs/reference/host-integration-capability-matrix.md` it classifies the host's plugin API, not spec-path emission. It shares a word with Phase 4b's "imperative reference" and nothing else.

### Reciprocal amendment notes

[ADR-3660](3660-runtime-artifact-layout-module.md) and [ADR-1016](1016-runtime-capability-descriptor.md) each carry an `Amended by: ADR-2866` back-reference, added in this same PR — the corpus's established practice for an amendment relation ([ADR-1016](1016-runtime-capability-descriptor.md) already carries the equivalent field for [ADR-2782](2782-reviewer-lane-capability-surface.md)). A one-way pointer is the failure mode this corpus has actually suffered: a reader landing on the amended file learns nothing about the decision that moved it.

Each back-reference states **when the widening takes effect** — the decision is recorded now (this ADR is `Accepted`); the shipped modules still resolve placement only until Phase 2 ([#2871](https://github.com/open-gsd/gsd-core/issues/2871)) lands. Recording the relation without that timing note would tell a reader the layout module already resolves triggers, which would be false for four phases.

*Mechanical note for future readers:* `scripts/gen-adr-index.cjs` tracks only `Supersedes`/`Subsumes` and their inverses. **`Amends` is not machine-checked in either direction** — the back-links above are a convention this ADR honors deliberately, not something the gate would have caught had they been omitted.

## Phase map

Each phase is its own issue and its own PR. `0 → 1 → 2 → 3 → 4` is a hard dependency chain; 5 and 6 are independent of 1–4 once 0 lands; 7 follows 5 and 6.

| Phase | Issue | Deliverable | ADR touched |
|---|---|---|---|
| 0 | [#2869](https://github.com/open-gsd/gsd-core/issues/2869) | This ADR + the `CONTEXT.md` correction | — |
| 1 | [#2870](https://github.com/open-gsd/gsd-core/issues/2870) | Install Scope Module — one resolved scope value | — |
| 2 | [#2871](https://github.com/open-gsd/gsd-core/issues/2871) | Trigger resolution + host-precedence axis | [ADR-3660](3660-runtime-artifact-layout-module.md), [ADR-1016](1016-runtime-capability-descriptor.md) amended here |
| 3 | [#2872](https://github.com/open-gsd/gsd-core/issues/2872) | Manifest `scope`+`runtime`; Installed Surface Resolver | [ADR-0008](0008-installer-migration-module.md) (migration) |
| 4 | [#2873](https://github.com/open-gsd/gsd-core/issues/2873) | **Resolves [#2218](https://github.com/open-gsd/gsd-core/issues/2218)** — detection floor + behavioral fix | — |
| 5 | [#2874](https://github.com/open-gsd/gsd-core/issues/2874) | Executed-plan return value | [ADR-58](58-runtime-install-policy-module.md) completed |
| 6 | [#2875](https://github.com/open-gsd/gsd-core/issues/2875) | Layout Materializer + #1874-F19 durable staging | needs its own ADR |
| 7 | [#2876](https://github.com/open-gsd/gsd-core/issues/2876) | Retire dead + pass-through installer exports | [ADR-1508](1508-runtime-artifact-conversion-module.md) / [ADR-857](857-capability-system.md) re-export mandate revisited |

## Consequences

- **#2218 is fixed and can no longer regress.** The coexistence case gets its first test in the suite's history: no test today installs a runtime at both scopes and asserts on the combined result.
- **Shadowing is decided in one module.** Today it is decided in the host, invisibly, and modeled nowhere. After Phase 2 it is a field on a returned value that an error message, `/gsd-health`, and a test can each read.
- **One resolved projection serves install, uninstall, `/gsd:surface`, the migration planner, and the docs matrix.** Adding a runtime stays "author one `capability.json`" — ADR-1016's stated goal — instead of also teaching N modules what its scopes mean.
- **Install becomes assertable as a value** (Phase 5), so the 10,539-line `install.test.cjs` can collapse toward the shape `runtime-artifact-install-plan.test.cjs` already demonstrates.
- **Deletions, not just additions:** 12 scope conversions in `bin/install.js`, 12 dead exports, and 2 of the 3 duplicate layout walkers. [#1874](https://github.com/open-gsd/gsd-core/issues/1874)-F19's durable-staging fix lands inside Phase 6's extraction rather than as a second conflicting pass over the same choreography.
- **The costs, stated:** ADR-1016's closed vocabulary is one axis wider and stays wider forever; the Runtime Artifact Layout Module now owns two concepts instead of one, which is a boundary future reviews must hold rather than keep widening; and Phase 3's manifest schema bump obliges a v1-tolerant read path for the life of that format — **users must not need to reinstall.** Phase 4a adds install-time output and must not change exit codes: a shadowed install is a warning, not a failure.
- **Extraction, not rewrite.** `bin/install.js` keeps working at every phase boundary. This is the pattern that has actually worked in this repo — [ADR-857](857-capability-system.md), [ADR-1508](1508-runtime-artifact-conversion-module.md) and [ADR-3660](3660-runtime-artifact-layout-module.md) have each moved one slice — and the reason the whole-installer rewrite is rejected below.

## Alternatives considered

1. **Fix #2218 directly today — bespoke detection in `bin/install.js`.** Rejected as the whole answer. The manifest records neither scope nor runtime, so the check would be a hand-rolled pair of existence probes, untestable through any interface, leaving the next cross-scope question equally unanswerable. Phase 4a delivers the same user-facing outcome built on something that can be asserted.
2. **Triage option 1 — make `--local` also emit a skill.** **Refuted** — see Decision §3. Personal overrides project, so the local tree stays unreachable.
3. **Triage option 3 — document scope mutual-exclusivity.** Rejected as a fix; retained only as the documented fallback if Phase 4b's mechanism is not approved.
4. **A SessionStart hook that repoints `~/.claude/gsd-core` per project.** Rejected. There is precedent for the mechanism (`hooks/gsd-ensure-canonical-path.js` symlinks a plugin tree into the global dir), but making a machine-global path depend on the cwd of whichever session ran last is unsafe with concurrent sessions in different projects.
5. **One big installer rewrite.** Rejected. `bin/install.js` is ~13.5k hand-authored lines with 42 test files bound to its exports. ADR-1016 predicted it would "shrink substantially"; three extraction ADRs have each moved a slice, and that is the approach with a track record here. A complex system that works evolved from a simpler one that worked — a from-scratch installer would have to rediscover every edge case the current one already encodes.
6. **Skip Phase 1 and put precedence directly in the layout module.** Rejected. A scope's precedence rank is a property of a *scope*, not of a *placement*, and the 12 conversion sites are exactly why nobody can currently thread it through. Putting it in the layout module would make the module's second concept a third.
7. **Sequence #1874-F19 separately from Phase 6.** Rejected on maintainer direction: Phase 6 rewrites that exact choreography, so landing the durable staging inside the extraction is one pass instead of two conflicting ones.
8. **Write this as a new ADR superseding ADR-3660.** Rejected. `Superseded` in this corpus means "do not follow this" and obliges naming a replacement; ADR-3660's placement decision is live and correct. Amendment is the accurate relation, and the corpus already models amendments as dated sections on the amended file.

## References

- Presenting defect: [#2218](https://github.com/open-gsd/gsd-core/issues/2218) — `--local` Claude install silently shadowed by a coexisting `--global` skills install
- Epic: [#2866](https://github.com/open-gsd/gsd-core/issues/2866); phases [#2869](https://github.com/open-gsd/gsd-core/issues/2869)–[#2876](https://github.com/open-gsd/gsd-core/issues/2876)
- Incorporated: [#1874](https://github.com/open-gsd/gsd-core/issues/1874)-F19 (durable user-artifact staging) lands with Phase 6; the rest of that epic is untouched
- Placement seam this amends: [ADR-3660](3660-runtime-artifact-layout-module.md); content sibling: [ADR-1508](1508-runtime-artifact-conversion-module.md)
- Descriptor vocabulary this widens: [ADR-1016](1016-runtime-capability-descriptor.md); its stability contract: [ADR-894](894-capability-declaration-format.md)
- Install-plan projection this completes: [ADR-58](58-runtime-install-policy-module.md); its generalization: [ADR-857](857-capability-system.md)
- Migration policy for Phase 3's schema bump: [ADR-0008](0008-installer-migration-module.md)
- The frame all of the above sit beneath: [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (EoS)
- The `@`-include constraint's original site: `hooks/gsd-ensure-canonical-path.js`

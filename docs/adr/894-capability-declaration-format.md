# ADR-894: Capability declaration format + registry generation [Accepted]

- **Status:** Accepted — ratified 2026-07-17 (originally Proposed 2026-06-08); see "Ratification" below
- **Date:** 2026-06-08 (amended same day across two design grillings — see "Grilling amendments")
- **Issue:** #894
- **Parent:** [ADR-857](857-capability-system.md) (Capability system) — resolves its Open question #1
- **Phase:** ADR-857 rollout phase 3a (design-only)
- **Subsumed by:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (GSD as an Embeddable Orchestration Engine) — read it first; see the amendment below
- **Amended by:** [ADR-2782](2782-reviewer-lane-capability-surface.md) (Reviewer Lane capability surface) — adds a `reviewer` role-typed body and a third `role` value (`"reviewer"`) to the declaration format.

## Amendment (2026-07-16): subsumed by ADR-1239 (EoS); status is stale

[ADR-1239](1239-gsd-embeddable-orchestration-engine.md) — **GSD as an Embeddable Orchestration Engine** (EoS), Accepted — subsumes this ADR as an adapter. The capability declaration format remains the vocabulary a descriptor is written in; EoS is the frame that decides how a host loads the engine at all.

**Read [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) first.**

Recorded because ADR-1239 declared this subsumption while this file recorded nothing.

## Ratification (2026-07-17): Proposed → Accepted

Ratified by explicit maintainer directive after independent re-verification of the evidence below; the `Proposed` label had been stale for roughly 39 days (2026-06-08 → 2026-07-17) after the format it specifies had already shipped.

**Evidence the decision shipped:**

- Owning issue [#894](https://github.com/open-gsd/gsd-core/issues/894) and parent epic [#857](https://github.com/open-gsd/gsd-core/issues/857) are both CLOSED / COMPLETED.
- `scripts/gen-capability-registry.cjs` (886 lines) implements the §4 generator: reads every `capabilities/<id>/capability.json`, validates each via `capability-validator.cjs`, and enforces the one-owner / acyclic / tier-monotone / config-exclusivity / unique-producer invariants.
- `gsd-core/bin/lib/capability-validator.cjs` (2,346 lines) validates the §2 schema, including the gate `check` discriminator — exactly one of `query` / `predicate` / `agentVerdict` (around lines 1566–1573).
- 37 real `capabilities/<id>/capability.json` files exist on disk; `capabilities/ui/capability.json` matches the ADR's worked UI example (`tier`/`requires`/`skills`/`agents`/`steps`/`gates`) near-verbatim, plus additive fields (`version`, `engines`, `runtimeCompat`) not in the original text.
- `capabilities/codex/capability.json` has concrete `role: "runtime"` enums filled in — `commandStyle: "shell-var"`, `hooksSurface: "codex-hooks-json"`, `sandboxTier: "codex-agent-sandbox"` — resolving the ADR's own "deferred to phase 5" open question.
- `scripts/gen-loop-host-contract.cjs` (18,992 bytes) parses the `<!-- gsd:loop-host … -->` comment markers out of the five step workflows (confirmed at `gsd-core/workflows/plan-phase.md:1`) into the generated host contract.
- `gsd-core/bin/lib/capability-registry.cjs` (235,826 bytes, generated) contains `byLoopPoint` (line 3033), `configKeys` (line 3578), and `requiresClosure()` (line 5779) — the role-partitioned §5 shape.

**Governance state:** owning issue #894 CLOSED/COMPLETED (closed 2026-06-08); parent epic #857 CLOSED/COMPLETED (closed 2026-06-14).

## Context

[ADR-857](857-capability-system.md) decided the **Capability** model: the five-step loop is the privileged host; every other feature is a Capability declared co-located and compiled into a generated central **Capability Registry**, owning its skills, agents, hooks, federated config-key schema, and **Loop Extension Point** registrations. ADR-857 deferred one detail to phase 3:

> *"The exact on-disk shape of a co-located Capability declaration (folder layout, declaration format)."*

The generator, the federated config loader (phase 3b), and the loop seam (phase 3c) all build against that format. This ADR fixes it **as a reviewable design** with no code, reusing the repo's proven co-located-source → generated-central pattern with a `--write`/`--check` drift gate (`scripts/gen-inventory-manifest.cjs`, `scripts/research-profiles.cjs`).

## Decision

### 1. Folder layout

```
capabilities/
  <id>/
    capability.json          # the declaration
    # (future) skills/ agents/ hooks/ loop/   — co-located owned artifacts
```

- `<id>` unique, kebab-case, equals the folder name.
- **Migration-staged ownership.** Declarations initially *reference* existing artifact locations by stem; the physical move into `capabilities/<id>/…` is the ADR-857 **phase-6 migration**. Format is identical either way.
- Genuinely shared artifacts (e.g. `gsd-planner`) stay in a core/host home and are **referenced, not owned**.

### 2. The `capability.json` schema

Schema-validated JSON. Common envelope + role-typed body (`role: feature | runtime`).

**Common envelope:**

| Field | Type | Notes |
|---|---|---|
| `id` | string (kebab) | unique; equals folder name |
| `role` | `"feature" \| "runtime"` | discriminator |
| `title`, `description` | string | label + summary |
| `tier` | `"core" \| "standard" \| "full"` | **the source of truth for install-profile + cluster membership** (§4); maps via tier + requires-closure |
| `requires` | string[] | **Capability ids only** (host is implicit). Generator enforces: exist, acyclic, **tier-monotone** (`core` may not require `standard`/`full`; `standard` may not require `full`) |

**`role: "feature"` body** — three typed hook arrays (one per ADR-857 hook kind):

| Field | Type | Notes |
|---|---|---|
| `skills` / `agents` | string[] | owned stems — exactly one owner each across all capabilities |
| `hooks` | `{event, script, matcher?}[]` | lifecycle hooks; optional `matcher` is a settings.json tool-scoping pattern (exact tool name, pipe-separated list, wildcard, or regex, e.g. `Write|Edit`); absent = match-all (see *#1634 amendment* below) |
| `config` | object | federated config-key schema slice |
| `steps` / `contributions` / `gates` | arrays | loop hooks (below) |

```jsonc
// Step — runs at a point as its own unit; order derives from produces/consumes
{ "point": "plan:pre", "ref": { "skill": "ui-phase" },     // {skill:…} | {agent:…}
  "produces": ["UI-SPEC.md"], "consumes": ["CONTEXT.md"],
  "when": "workflow.ui_phase",                               // config-level activation (§ below)
  "onError": "skip" }                                        // "skip" (default) | "halt"

// Contribution — injects a fragment into a NAMED agent role's prompt
{ "point": "plan:pre", "into": "planner",                   // into ∈ the step's published agentRoles
  "fragment": { "path": "loop/threat-model.md" },            // {path:…} | {inline:"…"}
  "when": "workflow.security_enforcement", "onError": "skip" }
// No produces/consumes; multiple contributions into the same agent render as ordered
// labeled blocks (<contribution from="<id>">…) by capability-id (ADR-857 decision 6).

// Gate — checks and optionally blocks
{ "point": "execute:wave:post",
  "check": { "query": "ui.safety-gate" },                    // {query:…} | {predicate:…} | {agentVerdict:…}
  "when": "workflow.ui_safety_gate", "blocking": true, "onError": "halt" }
```

**Hook activation (`when`).** A hook may declare a cheap, **deterministic `when`** over config keys + capability-enablement (e.g. `"workflow.ui_phase"`); `loop.render-hooks` evaluates it to decide whether the hook is active. **Deeper context applicability** ("is this actually a frontend phase?", "are ORM files in scope?") is *not* declared — it stays inside the dispatched skill/agent, which no-ops if inapplicable, exactly where that judgment lives today. This deliberately avoids a phase-context predicate vocabulary that would drift from reality. Consequence: when an entry step self-gates (produces no artifact), its downstream same-capability gate/step must **degrade gracefully** (e.g. `ui.safety-gate` passes when there is no `UI-SPEC.md`) — that is the skill/query's responsibility.

### Clarification — steps are additive, gates block, mode self-gates (resolving #1022)

A **`step` is purely additive** — it invokes a skill and may produce artifacts, but it **never halts or redirects the host workflow**. A host-blocking precondition (e.g. *"do not plan a frontend phase without a UI design contract"*) is modeled as a **`gate`** (`blocking: true`, `onError: halt`); gates already block, so steps gain no halt power. (Surfaced cutting over `plan-phase.md` §5.6, whose manual-mode branch hard-exits the host — that behavior is a gate, mis-inlined as step logic.)

**Runtime/mode context** — whether we are in a `--auto`/`--chain` pipeline vs a manual invocation — is likewise **not** a hook-activation concern (`when` is config-only and deterministic). It **self-gates inside the skill**, exactly as phase-context applicability does: the skill no-ops when its mode precondition isn't met.

**§5.6 worked decomposition.** The `plan:pre` **step** (`ref.skill: ui-phase`, `when: workflow.ui_phase`) auto-fires `gsd-ui-phase`, which self-gates on (a) frontend detection and (b) pipeline context — auto-generating `UI-SPEC.md` only in `--auto`/`--chain` runs. A new `plan:pre` **gate** (`check`: a "frontend phase with no `UI-SPEC.md`" query, `blocking: true`, `onError: halt`, `when: workflow.ui_safety_gate`) blocks planning in manual mode when a frontend phase still lacks a UI-SPEC — preserving today's "run `/gsd:ui-phase` first (or `--skip-ui`)" UX without forcing the interactive skill inline. Consequently the `loop.render-hooks` dispatch template handles **both** active steps (invoke the skill) and active gates (run the check; halt if blocking + failed), not steps alone.

**Gate `check`** is one of:
- `{ query: "<gsd_run query>" }` — deterministic first-party code; **may block**.
- `{ predicate: { kind: "artifact-exists" | "config-equals" | …, … } }` — declarative, no code; **may block**.
- `{ agentVerdict: { ref, prompt } }` — LLM check; **forced `blocking: false` (advisory)** — non-deterministic checks may not halt the loop.

**`role: "runtime"` body** (ADR-857 decision 8 — closed primitive vocabulary; no skills/steps/etc.):

| Field | Notes |
|---|---|
| `runtime.configHome` | config dir |
| `runtime.configFormat` | `settings-json \| toml \| markdown \| markdown-dir \| none` |
| `runtime.artifactLayout` | `{kind, destSubpath, prefix}[]` |
| `runtime.commandStyle` / `hooksSurface` / `sandboxTier` | closed enums (exact sets enumerated in phase 5) |
| `runtime.supportTier` | `1` (Claude/Codex/Antigravity) \| `2` |

### 3. The Loop Host Contract — generated from the workflows

Capability hooks attach to the host, so the host must publish what it exposes (points, agent roles, core artifacts) — otherwise `into: "planner"`, `consumes: ["RESEARCH.md"]`, and `point: "plan:pre"` are unverifiable strings.

**The contract is generated from the workflows, not hand-authored** — so it cannot drift into a lie. The five step workflows carry structured markers; a parser generates the contract from them:

```html
<!-- in gsd-core/workflows/plan-phase.md -->
<loop-point id="plan:pre"/>
<agent-role name="planner"/> <agent-role name="researcher"/> <agent-role name="checker"/>
<loop-artifact produces="PLAN.md" consumes="CONTEXT.md"/>
```

→ generated host contract entry:

```jsonc
{ "step": "plan", "points": ["plan:pre","plan:post"],
  "agentRoles": ["researcher","planner","checker"],
  "coreArtifacts": { "produces": ["PLAN.md"], "consumes": ["CONTEXT.md"] } }
```

The 12 points (illustrative roles): discuss `pre`/`post` (orchestrator); plan `pre`/`post` (`researcher`/`planner`/`checker`); execute `pre`/`wave:pre`/`wave:post`/`post` (`executor`/`verifier`); verify `pre`/`post` (orchestrator); ship `pre`/`post` (orchestrator).

**Generator validation against the (generated) contract:** every hook `point` ∈ host points; every `contribution.into` ∈ that step's `agentRoles`; every `step.consumes` is satisfiable by `coreArtifacts.produces` or an earlier hook's `produces`; `when` references valid config keys.

### 4. The generators

Two generated artifacts, both following `gen-inventory-manifest`'s `--write`/`--check` + build-wiring + CI drift-test pattern:

1. **`gen-loop-host-contract.cjs`** — parses the workflow markers (§3) → the host contract.
2. **`gen-capability-registry.cjs`** — reads every `capabilities/*/capability.json`, validates each against the JSON-schema (§2), then enforces cross-capability invariants (fail build on violation):
   - one owner per skill/agent stem;
   - `requires` exist, acyclic, **tier-monotone**;
   - hooks valid against the host contract (§3);
   - config-key ownership **exclusive AND complete** — a federated key must be owned by exactly one capability *and absent from the central `config-schema`* (presence in both = collision = a mid-flight migration; finish the move);
   - artifact-production **unique per Loop Extension Point** — no two capability steps may `produce` the same artifact at the same Loop Extension Point (ambiguous data-flow resolution per Decision #6 — rejected at gen time);
   - emits the registry (§5).

**`tier` is the source of profile/cluster membership.** Install profiles (`core`/`standard`/`full`) and surface clusters are **generated** from capability `tier` + the requires-closure — collapsing ADR-857's dual/triple toggle systems. `/gsd:surface` will operate on capabilities. (This generation lands in the phase-4 install integration; ADR-894 fixes the contract.)

### 5. The generated registry shape

One `capability-registry.cjs`, **role-partitioned indexes**; per-point hook ordering **materialized** (the generator owns ordering; `loop.render-hooks` owns runtime *activation filtering*):

```js
module.exports = {
  version: '<schema-version>',
  capabilities: { '<id>': {…validated…}, … },               // all roles, by id
  bySkill: {…}, byAgent: {…},                                // feature-role
  byLoopPoint: { 'plan:pre': {                                // ordering materialized
     steps:[…produces/consumes topo-sorted, cap-id tiebreak…],
     contributions:[…grouped by into, cap-id order…],
     gates:[…as declared…] }, … },
  configKeys: { '<key>': '<id>', … },
  runtimes: { '<id>': {…descriptor…}, … },                   // runtime-role
  requiresClosure(id) {…},
};
```

At a point, `loop.render-hooks` reads the materialized order, **filters to the active set** (`when` + enablement), and renders the concrete markdown the orchestrator executes (ADR-857 decision 5).

### Rollout & migration (how this avoids double-execution)

3a-impl builds the registry + host-contract artifacts and the generators **without wiring them into the live loop**. The loop keeps running its currently-inlined features. Each feature's **cutover is one atomic PR** (phase 6) that simultaneously *removes the inlined workflow call* and *activates the capability's hook* — so a feature is never both inlined and hook-fired. No double-run; the registry simply exists, validated, until each feature flips.

### Worked example — the UI capability

```json
{
  "id": "ui", "role": "feature", "title": "UI design contracts",
  "description": "UI-SPEC design contract + retrospective UI audit for frontend phases.",
  "tier": "standard", "requires": [],
  "skills": ["ui-phase", "ui-review"],
  "agents": ["gsd-ui-checker", "gsd-ui-auditor"],
  "hooks": [],
  "config": {
    "workflow.ui_phase":       { "type": "boolean", "default": true, "description": "Enable the UI design-contract gate during planning." },
    "workflow.ui_review":      { "type": "boolean", "default": true, "description": "Enable the retrospective UI audit." },
    "workflow.ui_safety_gate": { "type": "boolean", "default": true, "description": "Block execution on unmet UI-SPEC contracts." }
  },
  "steps": [
    { "point": "plan:pre",    "ref": { "skill": "ui-phase" },  "produces": ["UI-SPEC.md"],   "consumes": ["CONTEXT.md"], "when": "workflow.ui_phase",  "onError": "skip" },
    { "point": "verify:post", "ref": { "skill": "ui-review" }, "produces": ["UI-REVIEW.md"], "consumes": ["UI-SPEC.md"], "when": "workflow.ui_review", "onError": "skip" }
  ],
  "contributions": [],
  "gates": [
    { "point": "execute:wave:post", "check": { "query": "ui.safety-gate" }, "when": "workflow.ui_safety_gate", "blocking": true, "onError": "halt" }
  ]
}
```

`when` gates each hook on its config key (cheap/deterministic); whether the phase is *actually* frontend work is decided inside `ui-phase` (self-gate). The `plan:pre` step self-skips on a non-frontend phase, producing no `UI-SPEC.md`; the `execute:wave:post` gate's `ui.safety-gate` query passes gracefully when no `UI-SPEC.md` exists. (A `contribution` looks like security's: `{ "point":"plan:pre", "into":"planner", "fragment":{"path":"loop/threat-model.md"}, "when":"workflow.security_enforcement" }`.)

## Grilling amendments

This ADR was stress-tested in two rounds before merge; the format changed materially.

**Round 1 (format):** `loopHooks[]` → three typed arrays (`steps`/`contributions`/`gates`); `contribution.into: <agent-role>`; the Loop Host Contract added; `requires` = capabilities-only + tier-monotone; config federation = atomic move; one registry with role-partitioned indexes.

**Round 2 (operational reality):**
1. **Host contract is generated from workflow markers** (§3), not hand-authored — it can't drift.
2. **Staged cutover** — registry-only until atomic per-feature cutover; no double-run.
3. **`tier` is the source** of profile/cluster membership; profiles + clusters generated; `/gsd:surface` operates on capabilities.
4. **Gate `check`** = query / declarative-predicate / agentVerdict; agentVerdict forced advisory; only deterministic checks may block.
5. **Hook activation `when`** — declarative config-level gating; deeper context applicability self-gates in the skill (no phase-context vocabulary).
6. **`byLoopPoint` ordering materialized** in the registry; resolver filters active + renders. Same-capability hooks must degrade gracefully when an entry step self-gates.

**Amendment — #1634 (lifecycle hook `matcher`):** the `role: "feature"` `hooks[]` entry gained an optional `matcher` field. `matcher` is a settings.json tool-scoping pattern — exact tool name, pipe-separated list, wildcard, or regex (e.g. `Write|Edit`). The capability install path projects a declared `matcher` onto the emitted settings.json hook entry (an entry-level sibling of `hooks`, exactly matching the runtime's native shape); **absent means match-all** — the field is omitted, so the shipped capabilities' wiring is byte-for-byte unchanged. This closes #1634, where a tool-scoped `PreToolUse`/`PostToolUse` hook otherwise fired on every tool (a fail-closed guard could block the whole session). `matcher` is a settings.json-family concept; per-runtime matcher projection (ADR-857 D8, runtimes-as-descriptors) is deliberately left as a separate concern rather than baking a raw Claude regex into every runtime's projection. The validator gates `matcher` to a non-empty string with no control characters.

## Consequences

**Positive**

- The format is *enforceable*: hooks validate against a **generated** host contract (no drift), `requires`/`tier`/config invariants are machine-checked, and ordering is materialized + testable.
- `tier`-as-source collapses ADR-857's multiple toggle systems into one generated truth.
- Staged cutover means the whole machinery can land and be validated with zero risk to the live loop until each feature deliberately flips.

**Negative / costs**

- Two new generated artifacts (registry + host contract) and workflow markup to author and keep building.
- The 12 points + agent-role vocabularies + schema are a stability contract — additive-only.
- Config-key migration is atomic-per-feature by design (a half-migrated key fails the gate).

## Alternatives considered

| Decision | Rejected | Why |
|---|---|---|
| Hook shape | one polymorphic `loopHooks[]` | typed arrays let generator/resolver branch on a known shape |
| Contribution target | "inject into the step" | ambiguous for multi-agent steps; `into: <role>` is precise |
| `requires` | capabilities + host steps | host always present → trivially satisfied; capability-only keeps the graph meaningful |
| Registry | two registries / flat map | role-partitioned indexes in one artifact: one generator, role-correct surfaces |
| Config | both-allowed / central-until-cutover | atomic move keeps one source of truth |
| Host contract | hand-authored + drift test / runtime-assert | generate-from-workflows makes drift impossible by construction |
| Profiles | profiles authoritative / tier-default-with-overrides | `tier`-as-source is the ADR-857 unification goal |
| Gate checks | query-only / agentVerdict-blockable | predicates avoid trivial code; non-deterministic blocking gates flap |
| Activation | full `when` over phase context / enablement-only | config-level `when` is cheap+honest; phase context self-gates (no drift-prone vocab) |
| Migration | big-bang / source-flag | atomic per-feature cutover: safe, staged, no coexistence flag to retire |

## Open questions (genuinely deferred to build sub-phases — cheap to decide then)

- JSON-schema `$id`/versioning; where `capability.schema.json`, the workflow markers' schema, and the generated host-contract file live.
- The declarative-predicate vocabulary for gates (`artifact-exists`, `config-equals`, …).
- The exact `commandStyle`/`sandboxTier`/`hooksSurface` enums for `role: runtime` (phase 5, against the 15 runtimes).
- Point/role-set deprecation policy once third-party capabilities exist (additive-only holds until then; a rename/removal needs a major bump + deprecation window — deferred with third-party loading per ADR-857).

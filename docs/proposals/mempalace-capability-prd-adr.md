# PRD + ADR — MemPalace Capability

> **Status:** **Pre-Proposal** (the stage *before* `Proposed`). The first-party-plugin proposal **standard is not yet established**; this is exploratory and intentionally not a formal ADR yet. Advancement Pre-Proposal → Proposed → Accepted happens once that standard exists.
> **Tracking issue:** [#956](https://github.com/open-gsd/gsd-core/issues/956)
> **Type:** Feature Capability (ADR-857 plug-in)
> **ADR number:** TBD — assign when advanced to `Proposed`, then promote to `docs/adr/<issue>-mempalace-capability.md`
> **Format caveat:** This is the **first of a planned series** of first-party-plugin proposals. The PRD/ADR-combined instrument used here is **provisional** — a better PM format (RFC, PR-FAQ, one-pager + spike, opportunity/solution tree, problem-framing doc) may be adopted as the standard and this doc retro-fitted to it.
> **Depends on:** ADR-857 (Capability System), capability-registry generation, federated config, loop-resolver (`loop render-hooks`)
> **External dependency:** [MemPalace](https://github.com/MemPalace/mempalace) — local-first AI memory (ChromaDB + SQLite), MCP server + CLI + Claude Code hooks
> **Format:** Part I = PRD (problem, users, requirements, metrics). Part II = ADR (forks, decisions, manifest, rollout).

---

# Part I — PRD

## 1. Problem

GSD's memory today is **per-project and per-artifact**: `STATE.md`, `.planning/graphs/` (the gsd-graphify knowledge graph), phase `CONTEXT.md`/`PLAN.md`/`SUMMARY.md`, and `gsd-extract-learnings` output. These are excellent *within* a milestone but have three gaps:

1. **No durable cross-session recall.** A decision made in phase 3 is re-derived in phase 9 because nothing surfaces it at the right moment. The learnings exist on disk but are not *retrieved* at discuss/plan time.
2. **No cross-project memory.** A pattern learned in `gsd-core` is invisible when working in `gsd-pi`. There is no semantic search across the developer's whole body of work.
3. **No verbatim, time-aware decision graph.** `.planning/graphs/` is project-scoped and lacks temporal validity (when did a decision become true; when was it superseded?).

MemPalace solves exactly these: local-first verbatim storage (wings/rooms/drawers), semantic search, a temporal knowledge graph (subject→predicate→object with `valid_from`/`valid_to`), cross-project tunnels, and a ~600–900-token `wake-up` recall layer that "leaves 95%+ of context free."

The opportunity: **wire MemPalace into the GSD loop's natural memory moments** — recall before you think, capture after you decide — via the ADR-857 capability mechanism, so it is opt-in, declarative, and default-resilient (no behavior change when MemPalace is absent).

## 2. Users & personas

| Persona | Need | What the capability gives them |
|---|---|---|
| **Solo maintainer across many repos** (the gsd-core author) | "Why did I decide X three milestones ago?" answered without grep archaeology | Cross-project recall at discuss/plan; temporal KG of decisions |
| **Long-running autonomous runs** (`/gsd-autonomous`, cron) | Memory that survives context compaction and session boundaries | precompact capture; diary journaling; CLI-path capture that works headless |
| **Team onboarding** (`/gsd-milestone-summary` consumer) | A queryable narrative of how the project got here | Verbatim drawers + KG timeline per wing |
| **Privacy-sensitive users** | Memory that never leaves the machine | MemPalace is local-first by construction; capability adds nothing cloud-bound |

## 3. Goals

- **G1 — Deliberate recall.** Surface relevant prior decisions, patterns, and surprises at `discuss:pre` and `plan:pre`, cheaply (wake-up + targeted search), so planning starts informed.
- **G2 — Deliberate capture.** Persist phase artifacts and extracted learnings into the palace at `discuss:post`, `plan:post`, `verify:post`, and `ship:post`, mapped to a stable wing/room taxonomy.
- **G3 — Bidirectional KG sync.** Mirror GSD's decisions/learnings into MemPalace's temporal KG, and (in the stronger modes) read them back.
- **G4 — Cross-project knowledge.** Build tunnels between related wings so a pattern in one repo is reachable from another.
- **G5 — Session journaling.** Write a per-agent diary entry at `ship:post` and on long-run boundaries.
- **G6 — Default-resilient & opt-in.** `tier: full`, master toggle `mempalace.enabled` defaults **off**. Every hook is `onError: skip`. Absent MCP/CLI ⇒ loop proceeds unchanged.

## 4. Non-goals

- **N1** — Not replacing `gsd-extract-learnings` analysis; we *feed* it into the palace, not supersede it.
- **N2** — No third-party-code loading into gsd-core (ADR-857 §7 keeps that out of scope). Integration is via MemPalace's MCP tools + CLI only.
- **N3** — Not authoring a new MemPalace source-adapter (RFC-002); GSD ships text artifacts MemPalace already mines.
- **N4** — Not a blocking gate. Memory never halts the loop. (No `blocking: true` hooks.)
- **N5** — Not shipping MemPalace itself; the capability declares the dependency and wires it, but install/`pip install mempalace` is the user's action.

## 5. Functional requirements

### 5.1 Memory-relationship modes (selectable)

The capability exposes **three modes** via `mempalace.memory_mode`, so the user chooses how tightly MemPalace couples to GSD's native memory. **All three are first-class and selectable** (not a one-time design pick):

| Mode | `.planning/graphs` KG | Learnings / STATE | Recall source of truth | Coupling |
|---|---|---|---|---|
| **`augment`** (default) | stays native | stays native | GSD native; palace is an *additional* recall layer fed from artifacts | lowest — palace is write-mostly, read-optional |
| **`kg_backend`** | routed to `mempalace_kg_*` | stays native | KG queries hit MemPalace's temporal graph | medium — graphify reads/writes the palace KG |
| **`replace`** | backed by palace | backed by palace | palace is the durable store; GSD reads memory through it | highest — MemPalace is a hard dependency |

Mode is read at hook-render time and changes *which* MemPalace surfaces the rendered instructions invoke. Switching modes is a config change, not a reinstall.

### 5.2 Recall (read path)

- **FR-R1** At `discuss:pre`, inject a recall fragment instructing the orchestrator to run `mempalace wake-up --wing <wing>` (L0+L1, ~600–900 tokens) plus `mempalace_search(query=<phase topic>, wing=<wing>)` and surface the top drawers + any relevant `mempalace_kg_query` facts into discussion.
- **FR-R2** At `plan:pre`, a recall step (skill `mempalace-recall`) produces `MEMORY-RECALL.md` consuming `CONTEXT.md`: prior decisions, patterns, and *surprises* relevant to this plan, retrieved by semantic search + KG timeline, deduped.
- **FR-R3** Recall is read-only and side-effect-free; if MemPalace is unreachable, `MEMORY-RECALL.md` is written with an "unavailable" stub and the loop continues.

### 5.3 Capture (write path)

- **FR-C1** At `discuss:post`, file `CONTEXT.md` as a drawer in `room: decisions` (dedup via `mempalace_check_duplicate`), and extract decision facts into the KG (`mempalace_kg_add` with `valid_from` = phase date).
- **FR-C2** At `plan:post`, file `PLAN.md` as a drawer in `room: planning`.
- **FR-C3** At `verify:post`, file `SUMMARY.md`/`UAT.md` excerpts in `room: milestones`, and file confirmed *problems→fixes* in `room: problems`.
- **FR-C4** `gsd-extract-learnings` output (decisions, lessons, patterns, surprises) is mirrored into the KG and corresponding rooms, with provenance (`source_file`, `source_drawer_id`).
- **FR-C5** All captures are idempotent: re-running a phase re-files the same content without duplication (MemPalace deterministic drawer IDs + `check_duplicate`).

### 5.4 Cross-project & journaling

- **FR-X1** At `ship:post`, when `mempalace.cross_project_tunnels = true`, propose tunnels between this wing's rooms and related wings (`mempalace_find_tunnels`), creating those the user/agent confirms.
- **FR-X2** At `ship:post`, when `mempalace.diary_journal = true`, write a session-summary diary entry (`mempalace_diary_write(agent_name, entry, topic="phase-ship", wing)`).
- **FR-X3** At `ship:post`, optionally run `mempalace sync --wing <wing> --apply` to prune drawers whose source artifacts were archived/deleted (guarded: never global prune).

### 5.5 Passive auto-capture (optional, separate layer)

- **FR-P1** When `mempalace.auto_capture_hooks = true`, the capability's lifecycle hooks install MemPalace's native Claude Code hooks (`session-start`, `stop` @ every 15 human messages, `precompact`) so tool output and mid-session context are captured even between loop points. Default **off** (the deliberate loop hooks are the primary integration; this is belt-and-suspenders).

### 5.6 Transport selection (robustness)

- **FR-T1** Interactive runs prefer the **MCP tools** (rich, structured). Autonomous/headless/cron runs prefer the **CLI** (`mempalace mine|search|wake-up|sync`) because MCP servers may be absent in headless harness contexts. Rendered hook instructions name both and pick by run context.

## 6. Success metrics

| Metric | Target |
|---|---|
| Recall token cost at discuss/plan | ≤ ~1k tokens (wake-up + one search) |
| Phases with artifacts captured | ≥ 95% when enabled |
| Recall relevance (manual spot-check) | top-5 drawers judged relevant ≥ 80% of phases |
| Loop overhead when MemPalace absent | 0 (skip-on-error, no failures) |
| Cross-session decision reuse | qualitative: maintainer reports "surfaced something I'd forgotten" |
| Duplicate drawers from re-runs | ~0 (idempotent capture) |

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| MCP server absent in headless/cron | CLI fallback (FR-T1); never hard-depend on MCP |
| **Phase-6 not yet wired** — `loop render-hooks` is implemented but no workflow calls it yet | Interim: invoke `mempalace-recall`/`mempalace-capture` skills manually or via MemPalace's native hooks; capability ships *ready* for phase-6 cutover |
| Palace noise/drift | `check_duplicate` before file; `mempalace sync` prune; verbatim-only (no lossy summaries written) |
| AAAK is lossy (84% vs 96% R@5) | Capture stores **verbatim drawers**, not AAAK; AAAK only as an optional index (`compress`) |
| Privacy | Local-first by construction; capability adds no network egress |
| Over-capture cost | Capture only at phase boundaries + bounded artifacts; not every message (that's the optional passive layer) |
| Mode `replace` makes MemPalace a hard dep | Default `augment`; `replace` documented as opt-in with migration |

---

# Part II — ADR

## 8. Context

ADR-857 establishes the **host/core vs Capability plug-in** split: the five-step loop is the host; everything else is a Capability that contributes *data* (not control flow) at **12 stable Loop Extension Points** via three hook kinds — `step`, `contribution`, `gate`. Capabilities are declared in `capabilities/<id>/capability.json`, compiled by `scripts/gen-capability-registry.cjs` into `gsd-core/bin/lib/capability-registry.cjs`, and resolved at runtime by `loop render-hooks <point>`. Config keys are **federated** (new keys flow without editing the central `loadConfig` whitelist).

MemPalace is a natural Capability: it adds memory recall/capture behavior at loop points, owns its own skills/agents/config slice, and degrades gracefully. It calls **no gsd-core internals** — only MemPalace's MCP tools and CLI — so it fits ADR-857's "declarative + first-party, third-party code deferred" decision (the *integration glue* is first-party; MemPalace runs out-of-process).

## 9. Decision drivers

- Must be **opt-in** and **default-resilient** (G6) — memory is never load-bearing for the loop.
- Must map cleanly onto MemPalace's existing taxonomy (wings/rooms/drawers/KG) — no new MemPalace adapter.
- Must honor ADR-857's **data-not-control-flow** rule: hooks render *instructions*; the agent calls MemPalace.
- Must let the user pick coupling depth (`augment`/`kg_backend`/`replace`) without reinstall.
- Must work **headless** (CLI path), not just interactively (MCP path).

## 10. Resolved design forks

Mirroring ADR-857's "resolved decisions" structure:

1. **Capability role — `feature`.** Owns skills + agents + hooks + config slice. (A future `runtime`-role descriptor is unnecessary; MemPalace is CLI-uniform across harnesses.)
2. **Tier — `full`.** External dependency ⇒ opt-in only; never in `core`/`standard` profiles. Master toggle `mempalace.enabled` defaults **off**.
3. **Integration transport — MCP-primary, CLI-fallback.** No code module in gsd-core; rendered hook markdown instructs the agent to call `mempalace_*` tools (interactive) or `mempalace` CLI (headless). Avoids the not-yet-existing `gsd-tools runCommand` registry (ADR-857 phase-6).
4. **Capture content — verbatim drawers, not AAAK.** AAAK is lossy; we file exact artifact text. AAAK `compress` is offered only as an optional downstream index.
5. **Memory-relationship — three selectable modes, not one.** `mempalace.memory_mode ∈ {augment, kg_backend, replace}`, default `augment`. Mode is read at render time; it changes which MemPalace surfaces the rendered instructions hit (§5.1). This is the direct realization of the user's "all three as selectable options" requirement.
6. **Failure policy — skip everywhere; no gate.** Every hook is `onError: skip`; zero `blocking: true`. Memory failures never halt or fail a phase.
7. **Passive auto-capture is separate and off by default.** MemPalace's native `stop`/`precompact` hooks are a belt-and-suspenders layer behind `mempalace.auto_capture_hooks`; the deliberate loop hooks are the contract.
8. **Wing/room taxonomy is fixed by GSD semantics.** wing = project (from `project_code`/`mempalace.wing`); rooms = `decisions | planning | milestones | problems | learnings`; drawers = verbatim artifacts; KG = decision/relationship facts with phase-dated validity.

## 11. Loop Extension Point mapping

Using the 12 canonical points and per-step `agentRoles` from `loop-host-contract.cjs`. (`into` on a contribution must be a valid role at that point: discuss=`[orchestrator]`, plan=`[researcher,planner,checker]`, execute=`[executor,verifier]`, verify=`[orchestrator]`, ship=`[orchestrator]`.)

| Point | Kind | Ref / into | produces | consumes | `when` | Purpose |
|---|---|---|---|---|---|---|
| `discuss:pre` | contribution | into `orchestrator` | — | — | `mempalace.recall_on_discuss` | Inject wake-up + search recall into discussion |
| `discuss:post` | step | skill `mempalace-capture` | — | `CONTEXT.md` | `mempalace.capture_artifacts` | File CONTEXT → `decisions`; KG decision facts |
| `plan:pre` | step | skill `mempalace-recall` | `MEMORY-RECALL.md` | `CONTEXT.md` | `mempalace.recall_on_plan` | Retrieve prior decisions/patterns/surprises for the plan |
| `plan:post` | step | skill `mempalace-capture` | — | `PLAN.md` | `mempalace.capture_artifacts` | File PLAN → `planning` |
| `execute:wave:post` | contribution | into `verifier` | — | — | `mempalace.capture_artifacts` | Capture confirmed problems→fixes into `problems` |
| `verify:post` | step | skill `mempalace-capture` | — | `SUMMARY.md` | `mempalace.capture_artifacts` | File milestones; mirror `extract-learnings` → KG + `learnings` |
| `ship:post` | step | agent `gsd-mempalace-curator` | — | `UAT.md` | `mempalace.diary_journal` | Diary entry; cross-project tunnels; `sync --apply` |

All steps/contributions are `onError: skip`. No gates.

> **Note on `produces`/`consumes`:** these are the file-data spine the registry topo-sorts on. `mempalace-recall` *produces* `MEMORY-RECALL.md` so the planner can consume it; capture steps only *consume* (they emit to the palace, not to a tracked file artifact), which keeps them leaves in the topo-sort.

## 12. Palace mapping (GSD artifact → MemPalace)

| GSD artifact / event | Wing | Room | Stored as | KG facts |
|---|---|---|---|---|
| `CONTEXT.md` | `<project>` | `decisions` | drawer (verbatim) | `(<project>, decided, <decision>)` `valid_from=<phase date>` |
| `PLAN.md` | `<project>` | `planning` | drawer | `(<phase>, plans, <task>)` |
| `SUMMARY.md` / `UAT.md` | `<project>` | `milestones` | drawer excerpts | `(<phase>, delivered, <capability>)` |
| confirmed bug→fix | `<project>` | `problems` | drawer | `(<bug>, fixed_by, <fix>)` |
| `extract-learnings` (decisions/lessons/patterns/surprises) | `<project>` | `learnings` | drawer per item | typed triples w/ provenance (`source_drawer_id`) |
| superseded decision | — | — | — | `mempalace_kg_invalidate` (sets `valid_to`) |
| cross-repo pattern | two wings | — | — | `mempalace_create_tunnel(label=…)` |

**Mode behavior on this table:**
- `augment` — all *writes* above happen; *reads* (recall) come from GSD native + palace search, palace is never required.
- `kg_backend` — the KG columns route through `mempalace_kg_*`; `gsd-graphify` reads/writes the palace temporal graph instead of `.planning/graphs/`.
- `replace` — drawer + KG columns become the durable store; GSD's learnings/graph reads resolve through the palace.

## 13. The `capability.json` manifest (concrete)

`capabilities/mempalace/capability.json`:

```json
{
  "id": "mempalace",
  "role": "feature",
  "title": "MemPalace memory",
  "description": "Cross-session, cross-project memory: deliberate recall before discuss/plan and verbatim capture + temporal-KG sync at phase boundaries, via the MemPalace MCP server and CLI.",
  "tier": "full",
  "requires": [],
  "skills": ["mempalace-recall", "mempalace-capture"],
  "agents": ["gsd-mempalace-curator"],
  "hooks": [],
  "config": {
    "mempalace.enabled":                { "type": "boolean", "default": false, "description": "Master toggle for the MemPalace memory capability." },
    "mempalace.memory_mode":            { "type": "enum", "values": ["augment", "kg_backend", "replace"], "default": "augment", "description": "How MemPalace relates to GSD native memory: augment alongside, back the knowledge graph, or fully replace." },
    "mempalace.wing":                   { "type": "string", "default": "", "description": "Palace wing name; empty derives from project_code / project dir." },
    "mempalace.recall_on_discuss":      { "type": "boolean", "default": true, "description": "Inject wake-up + search recall at discuss:pre." },
    "mempalace.recall_on_plan":         { "type": "boolean", "default": true, "description": "Produce MEMORY-RECALL.md at plan:pre." },
    "mempalace.capture_artifacts":      { "type": "boolean", "default": true, "description": "File CONTEXT/PLAN/SUMMARY and learnings into the palace at phase boundaries." },
    "mempalace.mirror_kg":              { "type": "boolean", "default": true, "description": "Mirror decisions/learnings into MemPalace's temporal knowledge graph." },
    "mempalace.cross_project_tunnels":  { "type": "boolean", "default": false, "description": "Propose/create cross-wing tunnels at ship:post." },
    "mempalace.diary_journal":          { "type": "boolean", "default": true, "description": "Write a per-agent diary entry at ship:post." },
    "mempalace.auto_capture_hooks":     { "type": "boolean", "default": false, "description": "Install MemPalace's native stop/precompact Claude Code hooks for passive mid-session capture." }
  },
  "steps": [
    { "point": "discuss:post", "ref": { "skill": "mempalace-capture" }, "produces": [], "consumes": ["CONTEXT.md"], "when": "mempalace.capture_artifacts", "onError": "skip" },
    { "point": "plan:pre",     "ref": { "skill": "mempalace-recall" },  "produces": ["MEMORY-RECALL.md"], "consumes": ["CONTEXT.md"], "when": "mempalace.recall_on_plan", "onError": "skip" },
    { "point": "plan:post",    "ref": { "skill": "mempalace-capture" }, "produces": [], "consumes": ["PLAN.md"], "when": "mempalace.capture_artifacts", "onError": "skip" },
    { "point": "verify:post",  "ref": { "skill": "mempalace-capture" }, "produces": [], "consumes": ["SUMMARY.md"], "when": "mempalace.capture_artifacts", "onError": "skip" },
    { "point": "ship:post",    "ref": { "agent": "gsd-mempalace-curator" }, "produces": [], "consumes": ["UAT.md"], "when": "mempalace.diary_journal", "onError": "skip" }
  ],
  "contributions": [
    { "point": "discuss:pre",        "into": "orchestrator", "fragment": { "path": "fragments/recall-discuss.md" }, "when": "mempalace.recall_on_discuss", "onError": "skip" },
    { "point": "execute:wave:post",  "into": "verifier",     "fragment": { "path": "fragments/capture-problems.md" }, "when": "mempalace.capture_artifacts", "onError": "skip" }
  ],
  "gates": []
}
```

> **Validation notes (from the registry generator contract):** `id` is kebab-case and equals the folder name; `tier: full` so `requires` may be empty; each `when` key exists in this capability's own `config` block; every `contribution.into` is a valid agent role at its point; `fragment.path` is relative with no `..`; `enum` config carries `values` and a `default` in that set. Because all config keys are new (not in the central `config-schema.manifest.json`), they flow through the **federated** channel automatically — no `loadConfig` whitelist edit.

## 14. Skills & agent the capability owns

- **`mempalace-recall`** (`commands/gsd/mempalace-recall.md`) — markdown skill. Reads `CONTEXT.md`, derives a search query, runs wake-up + `mempalace_search` + `mempalace_kg_query`/`timeline`, writes `MEMORY-RECALL.md` (or an "unavailable" stub). Branches on `memory_mode` for read source. Names MCP-primary / CLI-fallback per run context.
- **`mempalace-capture`** (`commands/gsd/mempalace-capture.md`) — markdown skill. `check_duplicate` → `add_drawer` to the right room → `kg_add` facts (when `mirror_kg`). Idempotent. Branches on `memory_mode` for write target.
- **`gsd-mempalace-curator`** (`agents/gsd-mempalace-curator.md`) — agent. Ship-time curation: diary write, tunnel proposal/creation, `sync --apply` (wing-scoped, never global), and `extract-learnings` → KG mirroring with provenance.

## 15. Rollout phases

| Phase | Deliverable | Gate |
|---|---|---|
| **0 — Spike** | `mempalace init`/`mine`/`search`/`wake-up` against gsd-core's own `.planning/`; confirm wing/room mapping feels right | manual: recall surfaces real prior decisions |
| **1 — Manifest + registry** | `capabilities/mempalace/capability.json` + `gen-capability-registry.cjs --write`; CI staleness gate green; consistency gate (id≠CLUSTERS collision) | `--check` passes |
| **2 — Skills + agent + fragments** | the two skills, the curator agent, two fragment files; `augment` mode only | recall/capture work when invoked manually |
| **3 — Config + federated flow** | all `mempalace.*` keys resolve via federated config; `capability-state` resolver reports the capability | state resolver shows installed/surfaced + hook activity; **user can run `gsd capability enable mempalace` and `config-set mempalace.enabled true`** (inherited ADR-857 capability surface — UX-enable) |
| **4 — Modes** | `kg_backend` then `replace`; `gsd-graphify` routing seam | each mode round-trips a decision |
| **5 — Passive hooks + autonomous** | `auto_capture_hooks` installs native hooks; CLI-path capture verified headless (`/gsd-autonomous`, cron) | headless run captures with no MCP |
| **6 — Loop wiring (shipped via ADR-857)** | the host-loop workflows call `loop render-hooks` at each canonical point, so registered capability hooks auto-fire | with `mempalace.enabled`, a `/gsd-execute-phase` run **auto-produces `MEMORY-RECALL.md` at `plan:pre`**, files capture at `plan:post`/`verify:post` with **no manual invocation**, and the curator spawns at `ship:post` — **verified** (`gsd-tools loop render-hooks plan:pre` returns the `mempalace-recall` step) |

ADR-857 (the capability system + `loop render-hooks` infrastructure) is **released**, so the Phase-6 loop wiring is shipped: the host-loop workflows call `loop render-hooks` at each canonical point, and MemPalace auto-fires through it when `mempalace.enabled`. The skills (`/gsd-mempalace-recall`, `/gsd-mempalace-capture`) are also invocable directly for manual use.

### 15.1 Decision → Phase ownership (traceability)

Every design decision (§10) and user-facing capability is the explicit responsibility of exactly one phase. Cross-cutting policies are assigned a **primary** owner (the phase that first embodies them) with later phases that extend them noted:

| Decision / capability | Primary owner | Notes |
|---|---|---|
| D1 role=`feature` · D10 manifest · **D6 `onError:skip` no-gate policy** | **Phase 1** | D6 is encoded in the manifest's per-step `onError:skip`; every later phase inherits it. |
| D3 transport (MCP-primary / CLI-fallback) · D4 verbatim drawers · D8 wing/room taxonomy · UX-recall · UX-capture | **Phase 2** | D3's MCP-primary rendering lives in the skills/fragments; the CLI-fallback *headless* path is exercised in Phase 5 (UX-headless). |
| D2 tier=`full` opt-in · D11 federated config · UX-enable | **Phase 3** | UX-enable is the **inherited** `gsd capability enable mempalace` + `config-set` surface (ADR-857's CLI), verified in this phase — not a MemPalace-specific command. |
| D5 three modes | **Phase 4** | Deferred from Phase 2 ("augment only"); Phase 4 owns `kg_backend`/`replace` + the `gsd-graphify` routing seam. |
| D7 passive auto-capture · UX-passive · UX-headless | **Phase 5** | Native-hook install + the headless CLI-path transport (D3 fallback). |
| D9 loop-point map (7 points) · UX-auto · UX-curator | **Phase 6** | Wired via the **shipped** ADR-857 `loop render-hooks` infrastructure (ADR-857 is released); auto-fires when `mempalace.enabled` — verified end-to-end. |

### 15.2 Loop wiring status

ADR-857 (the capability system + the `loop render-hooks` resolver + the workflow call sites) is **released**. The host-loop workflows (`plan-phase.md`, `execute-phase.md`, `verify-work.md`, `ship.md`, `discuss-phase.md`) call `loop render-hooks <point>` at each canonical point, so any registered capability — including `mempalace` — auto-fires when its `when` gate is true. **Verified:** `gsd-tools loop render-hooks plan:pre --raw` with `mempalace.enabled: true` returns the `mempalace-recall` step (`capId: mempalace`, `produces: MEMORY-RECALL.md`), rendered into the workflow markdown. There is therefore **no outstanding cross-doc gating dependency** for UX-auto / UX-curator — the earlier "blocked on ADR-857 *Migrate*" framing (in the original §15 and a prior audit comment) is retracted: that phase shipped. The manual skills (`/gsd-mempalace-recall`, `/gsd-mempalace-capture`) remain available for direct invocation independent of the loop.

## 16. Registration tax (per ADR-857 + repo checklists)

1. `capabilities/mempalace/capability.json` (above).
2. `node scripts/gen-capability-registry.cjs --write` → regenerates `capability-registry.cjs` (do not hand-edit).
3. Add `commands/gsd/mempalace-recall.md`, `commands/gsd/mempalace-capture.md`.
4. Add `agents/gsd-mempalace-curator.md` (+ ripple to `scripts/research-profiles.cjs`/`docs/AGENTS.md` only if it's a research-profile agent — the curator is not, so likely n/a).
5. Add `capabilities/mempalace/fragments/recall-discuss.md` + `fragments/capture-problems.md`.
6. Config keys: new ⇒ federated automatically; **no** `loadConfig` whitelist edit.
7. Confirm `id: mempalace` does **not** collide with a `CLUSTERS` key in `src/clusters.cts` (HARD consistency gate) — if it does, match exactly or rename.
8. Surface/profile: `tier: full` ⇒ only the `full` profile; no `core`/`standard` edits.
9. `CONTEXT.md` glossary: add domain terms (Wing, Room, Drawer, Tunnel, Diary, AAAK, memory_mode) — glossary is a review gate.
10. No new `.cts` source module ⇒ skip the new-CLI-module checklist (`.gitignore`/inventory/eslint). If `kg_backend`/`replace` need a routing seam in `gsd-graphify`, that *does* trigger the CLI-module checklist for that file.
11. Docs: how-to ("Enable cross-session memory with MemPalace") + reference (config keys, modes) — missing docs is a PR blocker.

## 17. Open questions

Each open question is traced to the phase whose acceptance must **resolve** it (so a decision doesn't sit ownerless between phases):

1. **Wing identity** _(resolve in **Phase 0** spike)_ — one wing per repo (`project_code`) vs one per milestone? Recommendation: per-repo wing, milestone/phase as KG validity windows + rooms; revisit if wings get too coarse. The Phase-0 spike gate ("recall surfaces real prior decisions") is where this is validated.
2. **`replace` migration** _(resolve in **Phase 4**)_ — do we backfill existing `.planning/graphs/` into the palace KG, or only forward-fill? Recommendation: ship a one-shot `mempalace mine .planning/` + KG import as part of mode switch. Owned by the Phase-4 "Modes" gate.
3. **Curator agent tier** _(resolve in **Phase 2**)_ — the curator is operational (branches, API calls, error recovery) ⇒ `sonnet` model. Confirm at Phase-2 agent delivery.
4. **Headless MCP availability** _(resolve in **Phase 5**)_ — verify MemPalace's stdio MCP server *is* reachable under `/gsd-autonomous`/cron, or commit fully to the CLI path there (FR-T1). Owned by the Phase-5 headless gate.
5. **Loop wiring** _(resolved — shipped)_ — ADR-857 is released and the host-loop workflows call `loop render-hooks`, so Phase-6 auto-fire is wired and verified end-to-end (§15.2). The manual skills (`/gsd-mempalace-recall`, `/gsd-mempalace-capture`) remain available for direct use.
6. **Diary `agent_name`** _(resolve in **Phase 6**)_ — namespace per GSD role (`gsd-orchestrator`) or per repo? Recommendation: per repo+role so diaries don't collide across projects. Owned by the Phase-6 curator wiring (UX-curator).

---

## Appendix A — MemPalace surfaces used

- **MCP (interactive):** `mempalace_search`, `mempalace_check_duplicate`, `mempalace_add_drawer`, `mempalace_kg_add`/`kg_query`/`kg_invalidate`/`kg_timeline`, `mempalace_create_tunnel`/`find_tunnels`, `mempalace_diary_write`/`diary_read`, `mempalace_sync`, `mempalace_get_taxonomy`/`list_wings`/`list_rooms`.
- **CLI (headless):** `mempalace wake-up --wing`, `mempalace search`, `mempalace mine`, `mempalace sync --wing --apply`, `mempalace hook run`.
- **Native hooks (optional passive layer):** `session-start`, `stop` (every 15 human messages; `silent_save`), `precompact` (captures pre-compaction tool output).
- **Retrieval cost:** wake-up = L0 (identity, ~100 tok) + L1 (auto-summary, ~500–800 tok) ≈ 600–900 tokens.

## Appendix B — Why this is a clean ADR-857 fit

- Contributes **data** (rendered recall/capture instructions), not control flow.
- One **feature bundle**: skills + agent + hooks + config slice + (no) requires.
- **Co-located manifest**, generated registry, **federated** config.
- Uses only the **stable 12-point** surface; additive-only.
- **Default-resilient**: skip-on-error, opt-in, no gate ⇒ absent MemPalace = unchanged loop.
- Calls **no gsd-core internals** ⇒ respects "third-party code deferred"; the glue is first-party, MemPalace runs out-of-process.

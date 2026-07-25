# ADR-1239: GSD as an Embeddable Orchestration Engine

- **Status:** Accepted
- **Date:** 2026-06-14
- **Issue:** [#1239](https://github.com/open-gsd/gsd-core/issues/1239)
- **Epic:** [#857](https://github.com/open-gsd/gsd-core/issues/857) (Capability system)
- **Realizes / inverts:** [ADR-857](857-capability-system.md) Decision 8 — flips *projection* to *embedding*, and **unifies** them
- **Subsumes as adapters:** [ADR-1016](1016-runtime-capability-descriptor.md) (Runtime Capability Descriptor → the *declarative* adapter), [ADR-58](58-runtime-install-policy-module.md) (`InstallPlan`), [ADR-3660](3660-runtime-artifact-layout-module.md), [ADR-894](894-capability-declaration-format.md)
- **Distinct from:** [#956](https://github.com/open-gsd/gsd-core/issues/956) (third-party *feature* plugins / Connected Capabilities)

## Context

GSD is a **standalone installer that projects onto a host** — `npx @opengsd/gsd-core --codex` writes artifacts into `~/.codex` via a per-runtime descriptor (ADR-1016). That answers only "*how do we write our files onto a CLI we already know*." It does not let GSD be **embedded as an orchestration engine** a host loads as a plugin: a new host (a "pi console") has no path, and the dependency points the wrong way (GSD reaches into the host instead of the host embedding GSD).

We want the inversion: **GSD is the engine; the host loads it through a stable, negotiated interface; a third party writes the thin host-plugin.** This is "turn the CLIs into Capabilities like we did for the loop."

### The six interface points (the integration surface, already implicit in the code)

1. **Command / workflow invocation** — `gsd-tools.cjs` Command Routing Hub (ADR-0012) + the workflow/slash surface.
2. **Agent dispatch** — GSD spawns sub-agents through the host's Agent/Task primitive.
3. **Model invocation** — GSD tiers → host model ids.
4. **Lifecycle hooks** — `hookEvents`/`hooksSurface`/`extendedHookEvents`.
5. **State + config IO** — `.planning/` + config under a declared `configHome`.
6. **Artifact surface** — how the host renders GSD's commands/agents/skills.

### Research: how 8 supported/target hosts actually expose these (source of truth)

Surveyed Claude Code, Codex, OpenCode, **pi** (pi.dev), VS Code, Gemini CLI, Cursor, Cline, Hermes (official docs + local `capabilities/*/capability.json`). Two structural facts dominate:

**(a) Hosts split into two embedding modes.**
- **Imperative** (a programmatic plugin API): Claude Code (subagents + 30 hook events + MCP + `Agent()` tool), **pi** (TS extensions: `registerCommand`/`registerTool`/`registerProvider` + ~30 fine-grained hooks + `before_provider_request` payload mutation), OpenCode (JS plugins + ~25 events), VS Code (extension host: `vscode.lm`, chat participants, LM tools), Cline (SDK `AgentPlugin` with `beforeTool`).
- **Declarative** (files only, "no in-process extension API"): Gemini CLI (TOML commands + `.md` agents + 10 hook scripts), Cursor (`.mdc`/`.md` + 19 hook events via `hooks.json`), Codex (AGENTS.md prose + `/skills` menu, **no custom slash commands**), Cline-via-rules (`.clinerules` text — the surface GSD uses today, **0 programmatic events**).

→ **ADR-1016's projection model *is* the declarative-embedding adapter.** Imperative embedding is the new adapter. Both sit behind one negotiated interface.

**(b) Every interface point varies from rich → degraded → absent, per host.** Agent nesting alone: Claude foreground-unlimited/background-depth-5; Codex depth-1; Gemini strictly-flat; Cline depth-2 (leaf = read-only, no MCP); Hermes spawn-depth-2 orchestrator/leaf + kanban-async; OpenCode `subtask` synchronous-only; pi *no named-dispatch primitive*; VS Code DIY tool-loop. This is why the contract must be **negotiated**, not assumed.

### Precedent: MCP's negotiated lifecycle

MCP's `initialize` handshake has each side declare **capabilities** + a **protocol version**, and "a requestor SHOULD only augment a request with a capability the receiver declared." That is exactly the shape: the host-plugin declares which primitives it provides; GSD declares requirements; GSD **degrades gracefully** when a primitive is absent (generalizing #853 into a first-class contract).

## Decision

Define a **Host-Integration Interface**: a versioned, negotiated contract over the six interface points, with GSD as an **embeddable orchestration engine** consumed through it. A host integration is a **host-plugin** = a negotiated capability set + an *embedding-mode adapter* (declarative = ADR-1016 projection; imperative = code that drives host primitives) + a thin binding. First-party hosts are authored through the **same** interface a third party would use (dogfooding). Third-party loading is **purely additive** (opt-in loader + trust gate over the descriptor: schema validation + `configHome` write-confinement). This **unifies** projection and embedding rather than replacing one with the other.

### The negotiated capability schema (extends the ADR-1016 axes)

At load, host-plugin and engine exchange `protocolVersion` + a capability object. New axes the research requires:

- **`embeddingMode`**: `imperative` | `declarative` — does the host run GSD as code or interpret GSD's artifacts?
- **`commandSurface`**: `slash-file` (Claude/OpenCode, `gsd:`-namespaced) | `slash-programmatic` (pi/VS-Code-chat) | `slash-toml` (Gemini, `gsd.`-namespaced) | `palette` (VS Code) | `prose-only` (Codex). Drives how interface point 1 binds; `prose-only` is a real degradation.
- **`dispatch`**: `{ namedDispatch: bool, nested: bool, maxDepth: int, background: bool, subagentToolkit: 'full'|'read-only' }`. GSD's orchestration **flattens** when `maxDepth`/`nested` are insufficient (run plan/execute inline) — the #853 rule, generalized and tested.
- **`modelMode`**: `active` (host exposes `sendRequest`/provider registration → GSD calls the model: VS Code, pi) | `passive` (GSD can only inject prompts/instructions: Gemini/Cursor/Cline/Codex/OpenCode). Two model-layer adapters; `passive` means GSD expresses orchestration declaratively.
- **`hookBus`**: `host` (host fires events GSD subscribes to: Gemini/Cursor/Hermes/Codex/pi/OpenCode) | `engine` (host has no bus → GSD owns it internally and fires its own: VS Code) | `none` (no bus → degrade lifecycle gating to rule-text instructions: Cline-rules). Plus the **portable event floor** (`SessionStart`/`PreToolUse`/`PostToolUse`/`Stop`/`SessionEnd` — the "claude dialect" all hook-capable hosts share) and negotiated extended events.
- **`stateIO`**: `filesystem` (most) | `sandboxed-storage` (VS Code web: no arbitrary FS) | `session-log-append` (pi JSONL). `configHome` write-confinement applies to the filesystem case.
- **`transport`**: `mcp` (near-universal — Claude/Codex/OpenCode/VS-Code/Gemini/Cursor/Cline/Hermes all consume MCP) | `native-extension` (pi: MCP needs a community extension) — GSD may ship a **companion MCP server** binding interface points 1+5 (the MemPalace pattern, already shipping).
- **`runtime`**: `node` | `bun` (pi) | `sandboxed-web` (VS Code web: no `child_process`); + flags like `systemMessages: bool` (VS Code rejects system-role messages).

The **primitive vocabulary stays closed and first-party** (ADR-857 Decision 8): a host needing a novel primitive needs a *first-party* primitive; the negotiation surfaces "unsupported" rather than letting a descriptor inject code. (Third-party *code* contributions are #956.)

### Per-interface-point capability + degradation ladder (grounded)

| Interface point | Full | Degraded | Absent → fallback |
|---|---|---|---|
| 1 Command | `slash-file`/`slash-programmatic` (Claude, OpenCode, pi, Gemini, Cursor) | `slash-toml` namespacing (Gemini `gsd.`-prefixed) | `prose-only` (Codex): commands become AGENTS.md prose + skills menu |
| 2 Dispatch | nested + background + full toolkit (Claude fg) | shallow/flat/read-only (Codex d1, Gemini flat, Cline d2 read-only) | no named dispatch (pi): single-agent inline; build via SDK sub-session |
| 3 Model | `active` (VS Code `lm`, pi providers, `before_provider_request`) | per-agent model field only (OpenCode, Gemini sub-agent) | `passive`: instruction-injection only; no tier routing |
| 4 Hooks | host bus, rich events (Claude 30, pi 30, Cursor 19) | host bus, thin events (Hermes 6, Codex 10 command-only) | `engine`-owns-bus (VS Code) / `none` → rule-text (Cline) |
| 5 State | filesystem `.planning/` (all CLIs) | sandboxed storage (VS Code) | session-log append (pi); Memento index |
| 6 Artifact | `/` typeahead + `@agent` + mgmt UI (Claude) | menu/`@`-only (Codex `/skills`, Gemini passive skills) | palette + chat participant only (VS Code: skills become LM tools) |

## Consequences

**Positive:** GSD embeds into any host with a plugin mechanism (Codex/OpenCode/pi today; a new "pi console" tomorrow) with no GSD source change; projection and imperative embedding unify under one contract; the agent-nesting bug class becomes a declared, tested capability; the engine gains a clean boundary; per-host degradation is explicit and testable rather than scattered `runtime === '…'` checks.

**Negative / cost:** a multi-phase refactor drawing a boundary through `bin/install.js` (the residue: inline agent loop, missing `destSubpath` write-confinement, `getDirName`/`_applyRuntimeRewrites`/post-layout hooks); two model adapters + two embedding adapters to build and test; per-interface-point degradation must be specified and parity-tested per host; trust-gate (write-confinement) is security-load-bearing; IDE hosts (VS Code) break terminal/shell/file-slash assumptions and need a distinct profile.

## Phased migration (the epic, #1239)

- **Phase A — Define the interface** (this ADR): six points, the negotiated capability schema above, protocol version, and the degradation ladder.
- **Phase B — Engine ↔ host boundary**: separate orchestration core (loop, `gsd-tools`, state) from install/projection; fold per-runtime residue into descriptors (absorbs #1173/ADR-1235 + the `install.js` residue list); add `destSubpath` write-confinement.
- **Phase C — Two embedding adapters + trust gate**: formalize the *declarative* adapter (today's projection) and the *imperative* adapter; opt-in external-descriptor loader + schema validation + `configHome` confinement; the MCP-companion-server binding.
- **Phase D — Dogfood one reference host per profile**: a *programmatic-CLI* (Claude or pi), a *declarative-CLI* (Gemini or Codex), and an *IDE* (VS Code) — re-authored through the public interface, with golden parity for the CLIs.
- **Phase E — Third-party SDK + docs**: publish the interface + reference host-plugins; a new host is a plugin someone writes.

Each phase is its own `approved-*` issue + PR with equivalence/parity proof.

### Amendment — Phase A implemented (#1684, v1.7.0)

Phase A is **implemented** and Phases B–E have landed, so this ADR is **Accepted** (Status flipped from `Proposed` once Phase E shipped the published SDK + serialized handshake + versioning policy + Diátaxis docs). The negotiated capability schema is materialized as a pure, additive, no-I/O module — the **Host-Integration Interface** (`src/host-integration.cts` → `gsd-core/bin/lib/host-integration.cjs`):

- **The eight negotiated axes** are carried under `capability.json` `runtime.hostIntegration` (extending, not replacing, the ADR-1016 axes), validated by `validateRuntimeBody` (`capability-validator.cjs`) across all 16 runtime descriptors, with the closed vocabulary kept in lock-step by a parity guard.
- **`PROTOCOL_VERSION`** is an integer starting at `1`, **distinct** from the package `version` / `engines.gsd` semver (the `version`/`protocolVersion` overlap, resolved).
- **`negotiateHostCapabilities(host, engine?)`** performs the in-process `initialize` exchange and enforces the trust-boundary invariant `effective ⊆ host-declared ∩ engine-known`: an undeclared axis or an unknown / higher-`protocolVersion` value is **never** trusted — it degrades to the most-restrictive known value (fail-closed), never throws.
- **`degradationFor`** is the typed Full/Degraded/Absent ladder table; **`profileOf` + `PROFILE_BASELINES`** classify each descriptor into `programmatic-cli` (9 hosts: claude, opencode, cursor, cline, hermes, qwen, kilo, trae, kimi), `declarative-cli` (7 hosts: codex, gemini, antigravity, augment, codebuddy, copilot, windsurf), or `ide` (defined as a baseline; no installed host yet — VS Code lands in Phase D).
- **Overlap resolutions (explicit):** `commandStyle` (GSD emission style, retained) ⊥ `commandSurface` (host surface type); `hookEvents` dialect ⊥ `hookBus` ownership (a host with `hooksSurface:none` may still be `hookBus:host` — e.g. opencode); `runtimeCompat` (feature→host) stays an independent override, orthogonal to these runtime→engine axes.
- **`extensionEvents` vocabulary (amendment, #1943).** The OpenCode extension-system event subset is a SEPARATE descriptor field + closed vocabulary, **not** a `hookEvents` value. `hookEvents` is the *managed-hook* dialect only (`claude`/`gemini`) — the event names GSD writes into a declarative host's settings.json. `extensionEvents` is the *plugin/extension-system* event surface an imperative host exposes: `{ opencode, pi, none }` (OpenCode ~25 plugin events; pi ~30 fine-grained events; `none` = the host exposes no extension surface and the engine owns the bus, e.g. VS Code). The former `opencode-subset` `hookEvents` value was this concept misfiled; it is now `extensionEvents: opencode`. Keeping them separate preserves the `hooksSurface:"none" ⇔ no-hookEvents` invariant (OpenCode declares `extensionEvents`, not `hookEvents`). Resolved by `extensionEventSurfaceFor` in `src/host-integration.cts`, validated by `VALID_EXTENSION_EVENTS` in `capability-validator.cjs`.

**Every per-host axis value is documentation-sourced, with citations.** Each of the 8 axes for all 16 installed CLIs was determined from that CLI's authoritative documentation (Context7 + the official dev docs/source), never inferred. The full per-CLI, per-axis matrix — value, source, and an evidence quote — is recorded in [`docs/reference/host-integration-capability-matrix.md`](reference/host-integration-capability-matrix.md), the deployment source-of-truth that Phases B–E build on. Where a CLI's docs genuinely do not state an axis, the descriptor carries the explicit `undocumented` sentinel (which `negotiateHostCapabilities` fail-closes on) rather than a guessed value — 22 such markers exist today, each with its search trail in the matrix. Two findings corrected this ADR's original appendix matrix: (1) current OpenAI **Codex** docs document slash-commands, so its `commandSurface` is `slash-file`, not `prose-only`; (2) several hosts run non-Node runtimes (opencode & kilo on **bun**; hermes & kimi on **python**; antigravity on **go**), so the `runtime` axis vocabulary was widened to `node|bun|sandboxed-web|python|go|rust|electron|other`. The documented `embeddingMode` split (9 imperative / 7 declarative, above) likewise reflects each CLI's real plugin/extension API, not a profile assumption.

No consumer wires the negotiated result yet — Phase A is interface-definition only; the engine↔host boundary (Phase B) and the adapters (Phase C) are where it is consumed.

## Amendment (2026-07-21): `effortSurface` axis (#2481)

> Adds a **ninth negotiated axis** covering reasoning effort. Raised by #2475: reviewer CLIs invoked as subprocesses by the review workflow silently inherit whatever reasoning effort sits in the user's own global CLI config, producing 1–3 minute review cycles on one machine and 12–15+ minute cycles on another with no in-project way to influence it.

**The gap.** Reasoning effort is a first-class, config-driven GSD concept that the negotiated schema does not describe. Three mechanisms exist and none of them meet:

1. **A core effort vocabulary and cascade** ([ADR-443](443-opus48-unified-effort-and-fast-mode-routing.md)) — `resolveEffortInternal` (`src/model-resolver.cts`) resolves a *universal* effort string through invocation override → `effort.agent_overrides.<agent-id>` → `effort.routing_tier_defaults.<tier>` → `effort.default` → canonical defaults.
2. **A core-owned per-runtime rendering table** — `EFFORT_RENDERING` / `renderEffortForRuntime` (`src/model-catalog.cts`), where each runtime declares `param`, `channel`, `supported` levels and a `clamp()` rule. It holds two entries (`claude`, `codex`) and its `channel` vocabulary is `frontmatter` | `api` — **both install-time artifact channels**. Its production callers are exactly those two channels: the static install-time renderer (`bin/install.js`, via `src/install-effort-resolver.cts`) and the manual `query resolve-execution` / effort-sync CLI surface (`src/commands.cts`). **No workflow or agent dispatch calls it**, so there is no invocation-time channel and no per-host declaration of one.
3. **This negotiated schema** — eight axes under `capability.json` `runtime.hostIntegration`. Effort is not among them; `modelMode` covers only whether the host lets GSD drive model *selection*.

`EFFORT_RENDERING` is performing this schema's job — declaring per-host support and degrading gracefully — but as a core table keyed by runtime name, at the wrong layer, predating this ADR. [ADR-443](443-opus48-unified-effort-and-fast-mode-routing.md) names the same gap in its own text: its dynamic paths *"exist only as CLI-callable resolver code… Nothing in the shipped orchestration actually calls them,"* and *"the only propagation channel actually wired into a real GSD flow is the static one (config → `install()` → frontmatter, baked once at install time)."*

**The axis.** `effortSurface` declares **how reasoning effort reaches a host** — a two-value closed vocabulary consistent with the existing axes:

- **`argv`** — effort is deliverable as an argument on the host's own invocation (claude `--effort`; opencode `--variant`; codex via the generic `-c model_reasoning_effort=` config override). This is the channel the schema was missing.
- **`none`** — the host exposes no reasoning-effort mechanism.
`undocumented` is **not** a value of this vocabulary. It is the corpus-wide sentinel (`UNDOCUMENTED` in `src/host-integration.cts`) that any axis may carry when a host's documentation does not state a value: it validates, but never propagates into effective axes — failing closed exactly like an unknown or missing value. A host whose effort mechanism is undocumented carries the sentinel and negotiates to the safe floor.

Per-host `param` name, accepted level set, and clamp rule are carried **in the descriptor** rather than a core table, so `EFFORT_RENDERING` collapses into descriptor data rather than growing a parallel vocabulary.

**Degradation ladder — interface point 3 (Model) gains an effort row:**

| Interface point | Full | Degraded | Absent → fallback |
|---|---|---|---|
| 3 Model — effort | `argv`: universal effort rendered onto the invocation, clamped to the host's level set | *(no rung — see below)* | `none` / `undocumented`: effort is not propagated; host default stands |

**Why there is no `config-file` member.** A config-file-only effort surface is a real shape — Gemini CLI exposed exactly that (`thinkingConfig.thinkingLevel` / `.thinkingBudget` under `modelConfig.generateContentConfig`, settable only in settings.json model presets). It is nonetheless **not** a vocabulary member, because no supported runtime has one:

- **Gemini CLI was removed from this repo as a sunset runtime** — `capabilities/gemini/capability.json` was deleted by commit `8f2ebbe9b` (#1928, PR #1996), following Google's own transition notice (`developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/`).
- **Antigravity CLI**, its documented successor, states no reasoning or thinking setting on its features/settings page (`antigravity.google/docs/cli/features`).
- **ZCode**, the other declarative host with a rich config surface, states none either (`zcode.z.ai/en/docs/configuration`).

A closed, first-party vocabulary with a member no host can claim is an invitation to guess. If a supported host later documents a config-file effort surface, adding the member is a small, evidence-backed change — and the degradation ladder already has the shape for it.

**Boundary against #2313.** That epic (whose own Phase 0 records the Codex passive-model posture as a separate ADR, not yet written) owns the **static / install-time** effort channel for Codex — `model_reasoning_effort` in generated `~/.codex/agents/<agent>.toml` under the passive posture, plus a sync path — and explicitly places *"orchestrator effort-override drift"* outside its scope. This amendment covers the **invocation-time** channel only and does not change install-time emission. The two channels may share a descriptor once `EFFORT_RENDERING` folds in.

**Evidence.** Per this ADR's own rule that axis values are documentation-sourced and never inferred: `claude --effort` and `opencode --variant` were verified against each CLI's `--help`; codex's `-c model_reasoning_effort=` and gemini's `thinkingConfig` were verified against first-party documentation. **The remaining installed hosts were not researched for this axis and must carry the explicit `undocumented` sentinel**, joining the 28 sentinels already carried across the 18 descriptors that declare `hostIntegration`, rather than inheriting a guessed value from a profile baseline.

**Corrections to the Phase A amendment's counts** (recorded here rather than by editing that section, since ADRs are append-only). The Phase A text states "all 16 installed CLIs" and "22 such markers exist today". Both have drifted: **18** descriptors now declare `runtime.hostIntegration`, carrying **28** `undocumented` sentinels. The lists have since drifted in both directions, for different reasons: **`zcode`** carries a descriptor but is named in neither list, and **`gemini`** is named in the declarative list but its descriptor was **deliberately deleted** by `8f2ebbe9b` (#1928, PR #1996) when Google sunset Gemini CLI in favor of Antigravity CLI. Any per-host work on this axis must enumerate the descriptors from the tree, not from those lists.

**Relationship to [ADR-443](443-opus48-unified-effort-and-fast-mode-routing.md).** That ADR is `Proposed`, blocked on its decided invocation-override and escalation paths having no live caller, and its own text recorded the choice of unblock path as a maintainer call it did not make. It is amended in the same change (#2481) to select path (a), to record that audit issue #1192's action-plan item 18 was never converted into a tracked follow-up, and to correct its own stale audit: the blocker's grep excluded `references/*.md`, which is `@`-included into workflows, and predates #2296's escalation caller. This axis does not by itself satisfy either of path (a)'s two mechanisms — see that ADR's amendment for the precise status. `effortSurface` is therefore the declaration layer for a decision ADR-443 already made; it does not restate ADR-443's cascade or enum.

**Status:** delivered in #2481 — axis vocabulary, descriptor values, validator parity, fail-closed negotiation, the degradation row, and the consuming review-lane wiring all land together. `effortSurface` is a wired axis, not a declared-but-unconsumed one; it is the first negotiated axis whose consumer is an invocation-time argument rather than an install-time artifact.

## Host-capability profiles (negotiation baselines)

- **Programmatic-CLI** (Claude Code, pi, OpenCode): imperative; full dispatch; host hook bus; MCP; `slash` surface. The richest target — minimal degradation.
- **Declarative-CLI** (Gemini, Cursor, Codex, Cline-rules, Hermes): declarative (projection); host hook bus or none; passive model; shallow/flat dispatch; MCP (except via rules). The ADR-1016 path.
- **IDE** (VS Code): imperative but *not a terminal* — palette/chat surface, engine-owned hook bus, `active` model (no system messages), sandboxed state, possible no-`child_process`. A distinct profile that most stresses the interface.

## OpenCode binding (worked host-plugin)

> **Amendment — OpenCode worked binding (#1239, 2026-06-22).** Makes the abstract *programmatic-CLI* profile concrete for OpenCode, grounded in its plugin API (`opencode.ai/docs/plugins`, retrieved 2026-06-22) — the first reference target for Phase D. It is also the answer to "can a GSD *capability* be a standalone OpenCode plugin": **the skills can; the loop overlay cannot — without the engine.**

### What an OpenCode plugin actually is (the binding substrate)

A plugin is a JS/TS module exporting an `async` function that returns a **hooks object**. It is loaded either from `.opencode/plugins/` (project) / `~/.config/opencode/plugins/` (global), or as an npm package named in `opencode.json` `"plugin": [...]` (installed with Bun at startup; deps via `.opencode/package.json`). The function receives `{ project, directory, worktree, client, $ }` — `client` is the OpenCode SDK, `$` is Bun's shell. Extension primitives: an `event` hook (the bus), `tool.execute.before`/`after` interceptors, per-tool `tool: { name: tool({...}) }` custom tools, `shell.env` injection, `experimental.session.compacting` context/prompt injection, and `client.app.log` structured logging. **This is the entire imperative adapter surface for OpenCode** — there is nothing phase-aware in it.

### Six interface points → OpenCode primitives

| Point | OpenCode binding | Negotiated axis value | Degradation |
|---|---|---|---|
| 1 Command | slash-file commands projected to the xdg command dir (`gsd:`-namespaced); plugin may also surface entrypoints as custom `tool()`s and drive `tui.command.execute` | `commandSurface: slash-file` | none (full) |
| 2 Dispatch | `mode: subagent` / `@`-mention; `subtask` is **synchronous-only** | `dispatch: { namedDispatch:true, nested:true, background:false, subagentToolkit:'full' }` | no background → waves run inline (the #853 flatten rule) |
| 3 Model | per-agent `model` field on the agent `.md`; no provider `sendRequest` | `modelMode: passive` | tier routing degrades to per-agent model field |
| 4 Hooks | host `event` bus (~25 events) | `hookBus: host`; `extensionEvents: opencode` (Phase D / #1943) | session/tool-scoped only — see gap below |
| 5 State | filesystem `.planning/` + config under xdg `~/.config/opencode`; `opencode-jsonc` permissions sidecar (`permissionWriter: 'opencode'`) | `stateIO: filesystem` | `configHome` write-confinement applies |
| 6 Artifact | native Agent Skills + `@agent` subagents + slash commands | — | none (full) |

**Portable event floor → OpenCode events:** `SessionStart` ≈ plugin-init + `session.created`; `PreToolUse`/`PostToolUse` ≈ `tool.execute.before`/`after`; `Stop` ≈ `session.idle`; `SessionEnd` ≈ `session.deleted`; `PreCompact` ≈ `experimental.session.compacting`. `shell.env` covers env injection; `command.executed`, `file.edited`, and `permission.asked`/`replied` are extended events GSD can subscribe to but does not require.

### The load-bearing gap: the loop is phase-scoped, the bus is session-scoped

OpenCode's bus fires on **sessions, tools, files, and permissions** — never on **workflow phases**. GSD's 12 loop extension points (`plan:pre`, `verify:post`, `ship:post`…) have **no event on this bus**. So the imperative adapter for OpenCode cannot drive the loop *from host events*; the engine must own phase sequencing internally and treat OpenCode's bus as a **subset extension-event surface** — exactly what the `extensionEvents: opencode` vocabulary encodes (amendment #1943; formerly misfiled as a `hookEvents` value `opencode-subset`). Concretely:

- **Steps, gates, and most contributions fire from GSD's own workflow/command invocation (point 1), engine-side** — not from the host bus. The plugin invokes `gsd-tools.cjs` (via `$` or the companion MCP server) and the engine runs the loop resolver.
- **Only the contributions that align with a real host event bind to the bus.** The clean case is memory: a MemPalace-style capability's capture/recall already keys on `discuss:post`/`plan:post`/`verify:post`; those can *additionally* bind to `experimental.session.compacting` so memory persists across OpenCode's compaction — a concrete win the host gives us for free.
- **Gates that cannot be evaluated at a host event fail closed**, reusing the overlay model's synthetic-blocking-gate semantics (see `capability-overlay-model.md`) — never fail open just because the host lacks a phase event.

### How a capability reaches OpenCode (two adapters, one engine)

1. **Declarative (today, via ADR-1016 projection).** The capability's `skills`/`agents`/commands convert into OpenCode's xdg home; OpenCode runs them as native skills/subagents. **Lossy by design:** `steps`/`contributions`/`gates` — the orchestration — are dropped, because projection has no loop. Good enough when the capability is "just skills."

2. **Imperative (this ADR, the faithful path).** A thin `@opengsd/opencode-plugin` (or local `.opencode/plugins/gsd.ts`) that on init calls the engine's `loadRegistry({ includeInstalled: true })` as a library, composing first-party ∪ installed capability overlays with the **same** precedence, consent, and fail-closed-gate guarantees GSD already enforces — then binds the composed registry to the OpenCode primitives in the table above. The plugin stays thin **because it does not reimplement the loop resolver**; it delegates to it. This is the difference between "port the capability to OpenCode" (rebuilds the loop in a place that can't express it) and "embed the engine under OpenCode" (the loop stays where it lives).

### Lowest-effort first cut

Because OpenCode consumes MCP, the **companion MCP server** (the MemPalace pattern, already shipping) binds interface points 1 + 5 with **no bespoke plugin at all** — OpenCode connects to it like any MCP server and gets GSD command + state IO. Ship that first; add the thin `event`-bus plugin only to capture the `experimental.session.compacting` / `session.idle` bindings that MCP cannot reach. Sequence for #1239 Phase D: **(i)** MCP-companion binding → **(ii)** declarative skill projection (already built) → **(iii)** thin imperative plugin for the compaction/idle hooks → **(iv)** golden parity vs. the Claude reference host.

### New open question (OpenCode-specific)

- OpenCode installs plugins with **Bun**, but the engine matrix lists `runtime: node`. Decide whether the imperative plugin invokes the engine in-process (requires Bun-compatible engine entry) or shells out to a Node `gsd-tools.cjs` via `$` — and whether the companion MCP server makes that question moot for the first cut.

## Codex binding (worked host-plugin)

> **Amendment — Codex worked binding + `dispatch.isolation` capability (#2584, 2026-07-24).** Two things: (1) it introduces a **general, per-host-negotiated capability** — the `dispatch.isolation` sub-field, which declares how each host isolates concurrent same-wave executors (six hosts have confirmed support; see the support table below), enabling parallel `execute-phase` waves on hosts beyond Claude; and (2) it consolidates Codex's Phase-D-shipped six-point Host-Integration binding (#2088) into this ADR — the sibling of the OpenCode binding above — because Codex is the first *orchestrator-managed* consumer of the new capability. Per-axis values are the [capability matrix §codex](reference/host-integration-capability-matrix.md). Sequencing: the *code* builds on the worktree merge/cleanup gauntlet (open bug #2556) and lands after it; this design + the descriptor/matrix change do not.

### What Codex integration actually is (the binding substrate)

Codex is a **declarative-CLI** host (ADR-1239 profile `declarative-cli`). It exposes **no in-process programmatic API**; integration is entirely through files + external processes ([developers.openai.com/codex/plugins/build]): a `config.toml` under `$CODEX_HOME`, `hooks.json` lifecycle hooks (10 native events), MCP servers, and `SKILL.md`-based skills auto-discovered from `$HOME/.agents/skills`. GSD reaches Codex through the **declarative embedding adapter** (`createDeclarativeAdapter` → `installRuntimeArtifacts`), with the former hardcoded `isCodex` projection folded into descriptor-driven `runtime.hostBehaviors` (#2088). This is the entire adapter surface — there is nothing phase-aware in it; the engine owns loop sequencing and treats Codex's hook bus as a subset event surface.

### Six interface points → Codex primitives

Codex's full negotiated binding — the per-axis value, its documentation citation, and the evidence quote for all six interface points — is the **[capability matrix §codex](reference/host-integration-capability-matrix.md)**, the deployment source of truth. In summary: `embeddingMode: declarative` · `commandSurface: slash-file` · `modelMode: passive` · `hookBus: host` (10-event `hooks.json`) · `stateIO: filesystem` · `transport: mcp` · `runtime: node` · `effortSurface: argv`. Integration is **Phase-D-dogfood complete** (#2088): declarative embedding adapter, install/uninstall byte-parity-gated (`golden-install-parity/codex.json`), the `runtime === 'codex'` projection folded into `hostBehaviors`.

The one interface point this amendment changes is **Dispatch** — specifically executor isolation for wave parallelism, below.

> **Matrix update (Phase 0 deliverable).** The matrix gains a `dispatch.isolation` row for every host, carrying the value + citation, so this "see the matrix" pointer stays the single source of truth. That row is authored once the naming is locked (Open Question 2).

---

### Dispatch isolation — the one new mechanism (#2584)

**The gap.** Codex's `dispatch` axis already describes agent *nesting* (`maxDepth:1` — a child agent may spawn, no deeper), and `degradationFor` correctly flattens **nested** dispatch. But `/gsd:execute-phase` wave parallelism is a **different** concern: running N *independent* plans from one wave *concurrently*. That needs **executor isolation** — two executors in one checkout race on files, git state, hooks, and `.planning/`. Claude Code provides isolation through its harness (`isolation="worktree"` on `Agent()`); Codex has no harness-native equivalent, so GSD keeps `workflow.use_worktrees=false` on Codex and same-wave plans run **sequentially** (correctly fail-closed per #2531/#2486). Nothing in the negotiated schema describes *how a host isolates concurrent executors* — it is an implicit "the Claude harness does it" assumption.

**Decision — add `isolation` as a sub-field of the existing `dispatch` axis** (not a new top-level axis). It declares how a host isolates concurrent same-wave executors, negotiated by `dispatch`'s existing per-sub-field machinery. Closed vocabulary:

| `dispatch.isolation` | Meaning | Declared by (confirmed — see support table) |
|---|---|---|
| `harness-worktree` | The host's harness creates + binds a git worktree per executor; GSD passes the host's own isolation flag and calls no git itself. | `claude`, `cursor` |
| `orchestrator-worktree` | GSD process-spawns each executor with an explicit working directory (a headless-exec `--cd`/`--dir`/`--work-dir`) into a worktree GSD created, validates, and merges. | `codex`, `kimi`, `kimi-code`, `opencode` |
| `none` | No isolation primitive; same-wave plans run inline/sequentially (the #853 flatten rule). | every other runtime until documented otherwise |

`undocumented` remains the corpus-wide sentinel; it validates but fail-closes to `none`.

#### Two dispatch models — the distinction the research surfaced

`dispatch.isolation` selects **how** a wave fans out, and the two non-`none` values are two different execution models:

- **`harness-worktree` — host-driven fan-out.** GSD asks the host's own harness to spawn concurrent subagents, each natively isolated in a worktree the host creates. Requires the host's *native concurrent subagent dispatch* **and** native per-agent worktrees. GSD passes a flag; the host does the rest.
- **`orchestrator-worktree` — GSD-driven fan-out.** GSD itself process-spawns N independent headless CLI-exec runs, each bound to a GSD-created worktree via a working-directory flag. Concurrency is **OS-level** (GSD launches N processes); it does **not** use the host's native subagent tool and does **not** depend on the host's `dispatch.backgroundDispatch`. `backgroundDispatch` governs *harness* fan-out only; orchestrator fan-out needs only a headless exec + a cwd flag, so it is not a prerequisite for `orchestrator-worktree`.

Implementation consequence: the **new backend (creation verb + GSD-managed worktree/merge) is built once and serves all `orchestrator-worktree` hosts**, parameterized by the host's exec invocation (descriptor data). `harness-worktree` hosts need only the scheduler to pass their native flag — no new backend.

#### Confirmed per-host support (research #2584, cited to official docs)

| Host | Value | Mechanism | Evidence | Conf. |
|---|---|---|---|---|
| `claude` | `harness-worktree` | `Agent(isolation="worktree")` harness primitive | Claude Code Agent tool | high |
| `cursor` | `harness-worktree` | `cursor-agent -w/--worktree [name]` → `~/.cursor/worktrees/…`; native parallel agents | cursor.com/docs/cli/reference/parameters, /cli/using, /cli/changelog | high |
| `codex` | `orchestrator-worktree` | `codex exec --cd/-C <dir>`; native worktrees are **desktop-app-only**, `spawn_agent` sets no cwd (open issue #23095) | learn.chatgpt.com/docs/environments/git-worktrees, codex `shared_options.rs`, TS SDK `exec.ts` | high |
| `kimi` | `orchestrator-worktree` | `--work-dir` flag; concurrent "explore" subagents | github.com/moonshotai/kimi-cli/docs/en/faq.md, /agents.md | med-high |
| `kimi-code` | `orchestrator-worktree` | honors process cwd (no flag); `AgentSwarm` ≤128 concurrent | github.com/moonshotai/kimi-code/docs/en/reference/tools.md, /getting-started.md | med-high |
| `opencode` | `orchestrator-worktree` | `opencode run --dir <path>` (process-level); **native subagent is synchronous-only**, so harness fan-out is unavailable | opencode.ai/docs/cli, /plugins; opencode issues #14195/#29638/#5887 | med-high |
| `pi`, `zcode`, `windsurf` | `none` | can't fan out concurrently (no named dispatch / `background:false` / undocumented) — isolation is moot | shipped descriptors | — |
| others (`cline`, `codebuddy`, `copilot`, `hermes`, `kilo`, `qwen`, `augment`, `antigravity`, `trae`) | `undocumented` → `none` | not researched for this axis; fail-closed to sequential | — | — |

**So the answer to "are there others that can benefit": yes — five beyond Codex, definitively.** Two (`claude`, `cursor`) are `harness-worktree` (no new backend); three (`kimi`, `kimi-code`, `opencode`) share Codex's `orchestrator-worktree` backend. `pi`/`zcode`/`windsurf` genuinely cannot benefit and correctly stay `none`.

#### Two research findings that shape the code (not hand-waves)

1. **Codex sandbox constraint.** Under Codex's default `workspace-write` sandbox, `.git` is read-only, and Codex resolves a worktree's `.git` *pointer* to the real gitdir — which for `git worktree add` lives in the **main repo's** `.git/worktrees/<name>`, *outside* the worktree. So a sandboxed executor running `git commit` inside a GSD-created sibling worktree can be **blocked** (cited: codex `permissions.rs`). This aligns with — and reinforces — the single-writer design: **the orchestrator should perform the git operations** (merge/commit), the executor only edits files; or the sandbox `writable_roots` must include the resolved gitdir. A Phase-3 acceptance test must cover this.
2. **OpenCode descriptor is wrong (separate defect).** `capabilities/opencode/capability.json` declares `dispatch.background:true, backgroundDispatch:true`, but OpenCode's native subagent dispatch is **synchronous-only** (confirmed by opencode issues #14195/#29638/#5887; ADR-1239's text was right). This does not change OpenCode's `orchestrator-worktree` verdict (that path is `opencode run --dir` at the process level, not the native subagent), but the descriptor's `background`/`backgroundDispatch` values are a genuine accuracy bug that should be corrected independently of #2584. **Tracked as #2598.**

**Why a sub-field, not a new axis.** Isolation is a property of the dispatch/fan-out primitive — it is only ever consumed alongside `dispatch.background`/`maxDepth` when the scheduler decides whether a wave can fan out — and `dispatch` is already an object built to hold per-host fan-out properties. `dispatch` sub-fields are negotiated **independently** (`negotiateHostCapabilities`, `src/host-integration.cts:417-435`): each has its own floor (`FAIL_CLOSED_FLOOR.dispatch`, `:112`), its own `undocumented` warning, and its own `effective = host && engine` resolution. So `isolation` gets the full `effective ⊆ host-declared ∩ engine-known` trust invariant per-sub-field — an unknown value fails closed to `none` without dragging the other dispatch fields down — at strictly less surface than a standalone axis (no new top-level `VALID_` set, no new negotiation branch, no new profile-baseline entry). *(A standalone `isolationSurface` axis was considered and rejected: `effortSurface` earned its own axis because it is a model-layer concern orthogonal to dispatch and `modelMode` was a scalar it could not nest inside — neither holds for isolation.)*

**Consumer — runtime-neutral, no `runtime === 'codex'`.** `execute-phase` negotiates `dispatch.isolation` and dispatches through the matching isolation adapter, exactly as it already consults `degradationFor`/`shouldFlattenDispatch` for nesting:
- `harness-worktree` → pass the host's own isolation flag on dispatch (`isolation="worktree"` for Claude; `--worktree` for `cursor-agent`) and let the host isolate. No GSD git.
- `orchestrator-worktree` → the new backend (below): GSD creates the worktree and process-spawns the executor into it with the host's headless-exec cwd flag.
- `none` → run the wave's plans inline, sequentially (unchanged current behavior).

The per-host dispatch invocation (`harness` flag vs. the `orchestrator` exec command + cwd flag — `codex exec --cd`, `opencode run --dir`, `kimi --work-dir`, `kimi-code` process-cwd) is **descriptor data**, not a scheduler branch.

**The `orchestrator-worktree` adapter — the only genuinely new code.** ADR-1239's negotiation seam and the worktree merge/cleanup machinery already exist; the adapter wires them together plus one new primitive:
- **New:** a `worktree create` verb on the worktree command route (`routeWorktree`, `gsd-tools.cjs`, which today exposes cleanup-wave / record-agent / reap-orphans / base-check / set-baseref and **no creation verb**). Captures + validates one wave base, creates a bounded branch + worktree per plan, returns the explicit working directory for the executor. Bounded per the unbounded-subprocess gate (5–30s git timeout; degrade, don't throw).
- **Reused unchanged:** base capture, per-plan submodule gating, the serialized merge loop that stops the wave and retains the worktree on conflict (`executeWorktreeWaveCleanupPlan`, `src/worktree-safety.cts:664`), post-wave/post-phase gates, **manifest-only cleanup** (never glob-inferred).
- **Preserved invariant:** single-writer `STATE.md`/`ROADMAP.md`. `execute-plan` gates those writes on `IS_WORKTREE` (the `.git`-is-a-file primitive) — a GSD-created worktree trips the identical guard for free.
- **Shared validation:** both isolation adapters route their merge through the declared-scope conformance check tracked in #2596.

**Fail-closed.** An undeclared/unknown/higher-`protocolVersion` `dispatch.isolation` degrades to `none` (sequential) — never an unsafe parallel path.

**Validator parity.** `dispatch.isolation` gets a `VALID_DISPATCH_ISOLATION` closed set validated inside the existing `dispatch` validation (`capability-validator.cjs`), checked across all `hostIntegration` descriptors by the parity guard, and extends `FAIL_CLOSED_FLOOR.dispatch` with `isolation:'none'`.

---

### Consequences

**Positive.** Codex gains wave parallelism with **no `runtime===` branch** in the scheduler — isolation becomes a declared, negotiated, tested capability instead of a hardcoded harness assumption. The Codex binding is now consolidated into ADR-1239 as a first-class worked host-plugin, sibling to OpenCode. Claude's path is unchanged; it now merely *declares* `dispatch.isolation: harness-worktree` for what it always did.

**Negative / forever-cost.** A new closed-vocabulary sub-field on `dispatch` across descriptors; a new orchestrator-worktree adapter + its `(OS × runtime)` matrix we now own; the `worktree create` verb is new robustness surface on the git seam (bounded, manifest-scoped, fail-closed).

**Sequencing (hard).** The **code** builds on `executeWorktreeWaveCleanupPlan`, the subject of open `confirmed-bug` #2556 (the `cat-file -e HEAD:<path>` exit-code gate — 128-not-1, fails the SUMMARY rescue closed). **#2556 must land before any `orchestrator-worktree` code phase.** This amendment (design) and Phase 1 (the sub-field + descriptors + validator) do not touch the gauntlet and are not gated on it.

---

### Implementing epic (#2584)

Each phase is its own `approved-*` sub-issue + PR, dependency-ordered. **Phase 0 (this amendment) is docs-only and closes its own Phase-0 sub-issue, not the epic.**

- **Phase 0 — this ADR-1239 amendment.** The design lock: the Codex worked binding + the `dispatch.isolation` sub-field + the runtime-neutral scheduler consumer + the orchestrator-worktree adapter contract. Docs-only.
- **Phase 1 — the sub-field, declared but unconsumed.** `dispatch.isolation` schema + `VALID_DISPATCH_ISOLATION` + `FAIL_CLOSED_FLOOR.dispatch.isolation='none'` + per-field negotiation + validator parity; **descriptor values from the confirmed support table** (`claude`/`cursor`: `harness-worktree`; `codex`/`kimi`/`kimi-code`/`opencode`: `orchestrator-worktree`; the rest `none`/`undocumented`); **update `docs/reference/host-integration-capability-matrix.md`** with the `dispatch.isolation` row (value + citation) for every host. Golden-parity + validator + negotiation tests. No behavior change. *Not gated on #2556. (Docs may ride the Phase-0 amendment PR.)*
- **Phase 2 — the `worktree create` verb + orchestrator-exec dispatch.** Orchestrator-side creation primitive on `routeWorktree` (bounded, manifest-recorded, fail-closed) + the per-host headless-exec-with-cwd invocation (from the descriptor). Failing-first tests via `gsd-test`. **Gated on #2556.**
- **Phase 3 — the scheduler consumer + adapters, proven on one host per model.** `execute-phase` negotiates `dispatch.isolation` and dispatches: `harness-worktree` → the host flag (Claude already works; add Cursor's `--worktree`); `orchestrator-worktree` → Phase 2's verb → executor-with-cwd → the existing merge/validation gauntlet → #2596's scope check, with the **orchestrator performing the git ops** (per the Codex sandbox constraint). **v1 proves `orchestrator-worktree` end-to-end on Codex**; `kimi`/`kimi-code`/`opencode` are enabled by descriptor value + per-host validation once Codex is proven (they share the backend). **Gated on #2556 (and #2596 if it lands first).**

`/adr-phase-coverage` must confirm every deliverable is claimed by exactly one phase before code starts.

---

### Decisions & rollout

- **Form.** This lands as an amendment to ADR-1239, the sibling of the OpenCode binding above — Codex's integration already shipped (#2088); the ADR only lacked the Codex worked-binding section.
- **Naming.** The sub-field is `dispatch.isolation` with values `harness-worktree | orchestrator-worktree | none` (+ the `undocumented` sentinel). A sub-field over a new axis, and mechanism-specific values over abstract ones, both follow the `effortSurface`/#2481 precedent — terse `dispatch` sub-field naming (`nested`, `background`), the kebab-compound enum idiom (`slash-file`, `read-only`, `prose-only`), and "name only what a host actually has" (which excluded `config-file` for the same reason). A future non-worktree isolation adds `*-container` then, evidence-backed.
- **Rollout.** v1 proves the `orchestrator-worktree` backend end-to-end on Codex; the other orchestrator-worktree hosts (`kimi`, `kimi-code`, `opencode`) are descriptor-value + per-host-validation follow-ups on the *same* backend, and the `harness-worktree` hosts (`claude`, `cursor`) need only the scheduler to pass their native flag. Two research findings shape the code: the Codex sandbox constraint (the orchestrator performs the git operations) and the OpenCode descriptor bug (`background`/`backgroundDispatch` stale — tracked as #2598).

## Alternatives considered

1. **Projection-only (ADR-1016 as-is)** — rejected: never embeds; reverses the dependency.
2. **Per-host bespoke integrations** — rejected: the add-a-host tax ADR-857 exists to end.
3. **Expose only `gsd-tools.cjs` as "the API"** — rejected: the engine is the *loop* (dispatch + hooks + model + state), not just deterministic CLI ops; the six points are irreducible.
4. **One embedding mode** — rejected: the research shows hosts are split imperative/declarative; forcing one strands half of them. Two adapters behind one interface is the minimum.
5. **Fold into #956 (Connected Capabilities)** — rejected: that's the heavier code-loading door; the host door is data + thin adapter (the "wrong altitude" finding).

## Open questions (narrowed by the research)

- Exact wire-shape of the `initialize` handshake — in-process descriptor merge (declarative) vs a serialized capability exchange (imperative/SDK hosts like pi/VS Code).
- Where precisely to cut the engine↔host boundary (which modules are "engine" vs "host adapter").
- Whether the **companion MCP server** becomes the *primary* imperative transport (it covers points 1+5 on nearly every host) — and the pi fallback.
- The degradation ladder's *fatal-vs-degradable* line per point (e.g. is `prose-only` command surface acceptable, or does Codex stay projection-only?).
- Interface versioning/deprecation policy across capability-set evolution.

## Appendix — per-host capability matrix (research evidence)

| Host | Mode | Cmd surface | Dispatch | Model | Hook bus (events) | MCP | Runtime |
|---|---|---|---|---|---|---|---|
| Claude Code | imperative | slash-file (`gsd:`-ns) | nested fg ∞ / bg depth-5; `Agent()` | passive (per-subagent `model`) | host (30) | yes (bundle) | node |
| pi (pi.dev) | imperative | slash-programmatic | no named dispatch; SDK sub-session | **active** (providers + `before_provider_request`) | host (~30 fine) | community ext | **bun** |
| OpenCode | imperative | slash-file | `mode:subagent`/`@`; `subtask` sync | per-agent model | host (~25) | yes | node |
| VS Code | imperative/**IDE** | palette + chat `/` | DIY `lm` tool-loop | **active** (`vscode.lm`, no system msg) | **engine-owned** (none) | yes (provider) | node / **sandboxed-web** |
| Codex | declarative | **prose-only** + `/skills` | `max_depth=1` | passive (session-only) | host (10, command-only) | yes | node |
| Gemini CLI | declarative | slash-toml (`gsd.`-ns) | **flat** (no nesting) | passive (sub-agent `model:`) | host (10: BeforeAgent/Model/Tool) | yes | node |
| Cursor | declarative | slash-file (`gsd-`-ns) | host sub-agents; 19 hook events | passive | host (19) | yes | node |
| Cline | declarative (rules) | slash-file | `use_subagents` depth-2 read-only | passive | **none** (rules) / SDK `beforeTool` | yes | node |
| Hermes | declarative | slash-file | `delegate_task` depth-2 + kanban | passive (`pre/post_llm_call` unbound) | host (6) writes shared config | yes | node |

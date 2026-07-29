# ADR-1016: Runtime Capability Descriptor

- **Status:** Accepted
- **Date:** 2026-06-10
- **Issue:** [#1016](https://github.com/open-gsd/gsd-core/issues/1016)
- **Epic:** [#857](https://github.com/open-gsd/gsd-core/issues/857) (Capability system) — rollout phase 5
- **Realizes:** [ADR-857](857-capability-system.md) Branch 8 (host-CLI support as `role: runtime` Capabilities)
- **Materializes:** [ADR-58](58-runtime-install-policy-module.md) (the typed `InstallPlan` projection)
- **Builds on:** [ADR-3660](3660-runtime-artifact-layout-module.md) (artifact layout), [ADR-894](894-capability-declaration-format.md) (the `role: runtime` body, already validated)
- **Subsumed by:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (GSD as an Embeddable Orchestration Engine) — read it first; see the amendment below
- **Amended by:** [ADR-2782](2782-reviewer-lane-capability-surface.md) (Reviewer Lane capability surface) — a `role: "runtime"` capability may now carry a `reviewer` body **alongside** its runtime body. The runtime body itself remains closed and unchanged, and no feature-only field becomes permissible on it. ADR-2782 D6 **upholds** this ADR's closed-vocabulary principle: the lane's `handler` is a closed enum of first-party names (the `ConverterName` construction of Decision 3), never an open escape hatch, so §Alternatives #2 stands unreversed.

## Amendment (2026-07-16): subsumed by ADR-1239 (EoS) — this ADR is the *declarative adapter*, not the whole architecture

[ADR-1239](1239-gsd-embeddable-orchestration-engine.md) — **GSD as an Embeddable Orchestration Engine** (EoS), Accepted — subsumes this ADR **as the declarative adapter** in a larger frame, and inverts its direction of travel:

- This ADR answers *"how does GSD project its files onto a host CLI we already know?"* — GSD reaches into the host.
- ADR-1239 inverts that: **GSD is the engine; the host loads it through a negotiated Host-Integration Interface**, and a third party writes the thin host-plugin. ADR-1239 calls this "flips *projection* to *embedding*, and **unifies** them."

**This ADR is not superseded and its status is unchanged.** The runtime descriptor is real, live, and load-bearing: it remains the *declarative* adapter within EoS. But it is a **component of** the current architecture, not the statement of it. A reader who takes this ADR as the top-level answer to "how does GSD meet a host?" will reach the wrong conclusion for any new host.

**Read [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) first.**

Recorded because ADR-1239 declared this subsumption while this file recorded nothing, leaving the pointer one-way and EoS undiscoverable from here.

## Context

GSD installs into 16 host CLIs (claude, codex, gemini, opencode, kilo, cursor, copilot, antigravity, windsurf, augment, trae, qwen, hermes, codebuddy, cline, kimi). Today the per-runtime differences are encoded as **~287 conditional branches + 15 `is<Runtime>` boolean flags** in `bin/install.js`, plus scattered per-runtime switches in `runtime-homes.cts`, `runtime-config-adapter-registry.cts`, `runtime-artifact-layout.cts`, `runtime-slash.cts`, `runtime-name-policy.cts`, and `model-catalog.json`. **Adding one runtime touches ~18 hardcoded sites.** This is exactly the feature-scattering ADR-857 set out to end — for runtimes rather than features.

ADR-857 Branch 8 decided: host-CLI support becomes a `role: runtime` variant of the unified Capability. Feature Capabilities *produce* artifacts; Runtime Capabilities *project* them onto one host's conventions. Install composes **active Features × the chosen Runtime** at ADR-58's `InstallPlan` seam. A runtime descriptor is a **declarative value over a CLOSED named-primitive vocabulary** — not a code adapter; a genuinely new shape requires adding a first-party primitive (code + enum value), which is the dogfood path a future third-party would also use.

Two enabling pieces already exist:

- **The descriptor schema is authored and validated.** `gen-capability-registry.cjs` `validateRuntimeBody` validates a `role: runtime` capability's `runtime: { configHome, configFormat, artifactLayout, commandStyle, hooksSurface, hookEvents, sandboxTier, supportTier, installSurface, writesSharedSettings, permissionWriter, extendedHookEvents }`, forbids feature-only fields (`skills`/`agents`/`steps`/`contributions`/`gates`/`hooks`), and the registry exposes a `runtimes` index (currently `{}` — no descriptor authored yet).
- **ADR-58 defines the `InstallPlan`** as a pure typed projection (placements + command text + config intentions → adapters execute); it **is now materialized** — `runtime-config-adapter-registry.cts` realizes both the adapter-selection half and the plan-collection half via the exported `resolveInstallPlan(runtime)`, which `install()` and `finishInstall()` consume.

What is missing, and what this ADR fixes: only `configFormat` is a real closed enum (5 values); `commandStyle`/`hooksSurface`/`sandboxTier` are loose strings and `artifactLayout` is an unconstrained array. This ADR **closes the vocabulary for all eight original axes**, decides how the seven hard-case runtimes are absorbed as data, and fixes the staged migration that drives `install.js` from descriptors. Four additional axes — `installSurface`, `writesSharedSettings`, `permissionWriter`, and `extendedHookEvents` — were added to the descriptor and validator in the 5f-completion pass; they are documented in Decision 7a below.

## Decision

**Core principle:** every per-runtime difference is expressed as a value over a closed primitive vocabulary on twelve axes. A runtime that needs a shape no existing primitive expresses is supported by adding a first-party primitive (a new enum member + the code that honors it) — never by embedding arbitrary code or an open escape hatch in the descriptor. All 16 current runtimes MUST be expressible as data under the vocabulary below; any residue that genuinely cannot be is named explicitly as retained first-party code (§ Decision 8).

### 1. `configHome` — a structured value, not a path string

```
configHome: {
  kind: 'dot-home' | 'dot-home-nested' | 'xdg' | 'generic-agents-root',
  name: string,                 // e.g. 'claude', 'opencode'
  parent?: string,              // for dot-home-nested: e.g. '.gemini' (antigravity), '.codeium' (windsurf)
  env: string[],                // ordered override env vars, e.g. ['CLAUDE_CONFIG_DIR'] (required; may be empty)
  probe?: string[],             // ordered candidate subpaths; first existing wins (antigravity, kimi)
  probeExists?: string,         // marker sub-path on a probe candidate. generic-agents-root: hard filter (kimi: 'skills'). dot-home-nested: marker-priority preference, then bare-existence fallback (antigravity: 'gsd-core/VERSION', #213/#217) — see amendment below
  skillsHome?: { kind, name, ... }  // override when the skills dir ≠ config dir (kilo only)
}
```

- `dot-home` → `~/.{name}` (claude, cursor, codex, copilot, augment, trae, qwen, hermes, codebuddy, cline).
- `dot-home-nested` → `~/{parent}/{name}` (antigravity `~/.gemini/antigravity` + probe; windsurf `~/.codeium/windsurf`).
- `xdg` → `$XDG_CONFIG_HOME/{name}` ?? `~/.config/{name}` (opencode, kilo).
- `generic-agents-root` → the shared `~/.config/agents` / `~/.agents` first-existing root (kimi).

This absorbs kilo (`skillsHome` split), kimi & antigravity (`probe`), windsurf (`dot-home-nested`). `runtime-homes.cts` becomes a pure interpreter of this value.

`configHome` resolution is **pure and read-only** (a first-existing probe; no `mkdirSync` — verified in `runtime-homes.cts`). Any directory creation at install time is the `configFormat` permissions-writer's responsibility (opencode/kilo), never the descriptor-resolution step — so `configHome` carries no `createIfMissing` flag.

#### Amendment — `probeExists` on `dot-home-nested` (#1441, 2026-06-18)

`probeExists` was originally honoured only by `generic-agents-root` (kimi), as a *hard filter*. It is now also honoured by `dot-home-nested`, where it acts as a *preference*: probing first returns the candidate whose `<candidate>/<probeExists>` exists (the dir GSD installed into, marked by `gsd-core/VERSION`), then falls back to the legacy first-bare-existing pass, then `probe[0]`. When `probeExists` is absent the behaviour is byte-identical to the original first-bare-existing probe, so other `dot-home-nested` runtimes (e.g. windsurf, which has no `probe`) are unaffected. This fixes silent misresolution where an active sibling dir (the Antigravity-IDE `~/.gemini/antigravity`) shadowed a CLI install in `~/.gemini/antigravity-cli` — a regression introduced by #217. The existing `probeExists` field name is reused rather than introducing a parallel `probeMarker`, keeping the `configHome` vocabulary closed.

### 2. `configFormat` — the existing closed enum (unchanged)

`settings-json | toml | markdown | markdown-dir | none`. Cursor is `none` (it writes no settings file — its only managed file is the hooks manifest, captured by `hooksSurface`, not `configFormat`). opencode/kilo are `settings-json` with a JSONC **permissions sidecar** expressed by an optional `permissions: 'opencode-jsonc' | 'kilo-jsonc' | 'none'` sub-field (the only two runtimes that write one).

Claude's `permissions.allow/deny` (a tool-approval allowlist) rides as a sub-field of the `settings-json` variant — it is **not** a sandbox tier (see Decision 6).

### 3. `artifactLayout` — ADR-3660 `kinds[]`, keyed by scope

```
artifactLayout: {
  global: ArtifactKind[],
  local:  ArtifactKind[]
}
ArtifactKind = { kind: 'commands'|'agents'|'skills'|'kimi-agents', destSubpath: string, prefix: string,
                 nesting: 'flat'|'nested', recursive: boolean, stage: string }
```

Scope-keying is required generally, not just for the hard case: **claude itself differs** (global = `skills/`, local = `commands/gsd/` + `agents/`), and **cline** differs (global = skills + `.clinerules/`, local = `.clinerules/` only). ADR-3660 already absorbs hermes (`destSubpath: 'skills/gsd'`), opencode/kilo (`destSubpath: 'command'` singular), and gemini (commands-only, `.toml`) via `destSubpath`/`prefix`. The `nesting`/`recursive` flags carry the ns-* router nesting + non-recursive-loader facts (#924/#28266). The descriptor's `artifactLayout` IS the ADR-3660 layout, declared per runtime; `runtime-artifact-layout.cts` becomes its lookup table.

Each `ArtifactKind` names its per-runtime body converter (e.g. `convertClaudeCommandToGeminiToml`, the codex agent-TOML emitter) via a **closed `ConverterName` enum** — verified as 15 named first-party functions covering the 16 runtimes (three share Claude's). The converter is referenced by closed name, never embedded; closing it into a union type (vs today's open string) is what makes the "closed vocabulary" claim type-enforced rather than convention.

### 4. `commandStyle` — closed enum (2 values)

`slash-hyphen` (`/gsd-<cmd>`, 15 runtimes) | `shell-var` (`$gsd-<cmd>`, codex only). Gemini's own `gsd:`-namespaced TOML routing is a property of its command artifacts (a `commands/gsd/*.toml` layout fact), not GSD's emission style — it stays `slash-hyphen`.

### 5. `hooksSurface` — closed enum + a hook-event dialect

```
hooksSurface: 'settings-json' | 'codex-hooks-json' | 'cursor-hooks-json'
            | 'copilot-inline' | 'cline-rules' | 'none',
hookEvents?: 'claude'   // SessionStart/PreToolUse/PostToolUse
           | 'gemini'   // BeforeTool/AfterTool (gemini, antigravity)
           | 'opencode-subset'  // settings-json surface but SessionStart/PostToolUse skipped
```

`settings-json` covers claude, gemini, antigravity, augment, qwen, hermes, codebuddy; the event-name and registration-subset differences ride on `hookEvents` rather than splitting the surface enum. `none` = windsurf, trae, kimi, kilo, opencode — these five runtimes register **zero** managed lifecycle hooks today; `opencode-subset` is reserved ADR vocabulary with no current consumer (opencode and kilo write a `settings.json` for config/permissions, which is the `configFormat` axis, not the hook-registration axis).

### 6. `sandboxTier` — the agent-sandbox primitive (closed enum)

`none` (default — no per-agent sandbox) | `codex-agent-sandbox` (codex's `CODEX_AGENT_SANDBOX` map of agent → `workspace-write` | `read-only`, baked into each agent `.toml`). Codex is the **only** runtime with a non-`none` value today, so this is the thinnest axis — kept distinct from `supportTier` (coverage) and from model-catalog routing.

**Explicitly NOT on this axis** (verified, to prevent conflation): Claude's `permissions.allow/deny` is a *tool-approval allowlist* → it belongs on `configFormat`'s `settings-json` variant (Decision 2). The opencode/kilo permissions sidecar is a *filesystem read-grant* → it belongs on `configFormat`'s `permissions` sub-field (Decision 2). These three are categorically different mechanisms; only codex's per-agent sandbox mode is `sandboxTier`.

### 7. `supportTier` — GSD coverage tier (unchanged: 1 | 2)

`1` = fully tested first-party (claude, codex, antigravity); `2` = shipped, lower-tier (the other 13). None dropped. Drives the cross-runtime test matrix, not behavior.

### 7a. Install-surface axes — config-writing + the per-event hook SET (added in 5f completion)

Four axes added to the descriptor (and to `gen-capability-registry.cjs` `validateRuntimeBody`) in the 5f-completion pass. Together they retire the last hardcoded per-runtime tables in `runtime-config-adapter-registry` and `applySettingsJsonHooks`.

#### `installSurface` — closed enum (6 values)

```
installSurface: 'settings-json' | 'codex-toml' | 'copilot-instructions'
              | 'cline-rules' | 'cursor-hooks-json' | 'profile-marker-only'
```

Selects which config-writing adapter `resolveRuntimeConfigIntent` (in `runtime-config-adapter-registry`) returns. Previously `runtime-config-adapter-registry` held a hand-kept `REGISTRY` table mapping runtime names to adapter types; `installSurface` in the descriptor is now the **single source of truth** — the `REGISTRY` table has been retired.

#### `writesSharedSettings` — boolean

Whether the runtime writes a shared `settings.json`. Replaces the former inline boolean per runtime in `runtime-config-adapter-registry`. Together with `installSurface` this fully parameterises the adapter-selection path.

#### `permissionWriter` — `null | 'opencode' | 'kilo' | 'antigravity'`

The finish-time permissions-sidecar writer. `opencode`/`kilo` write a dedicated JSONC config file; `antigravity` (#2096 Phase B Upgrade 1) instead merges a `permissions.allow` array into the SAME shared `settings.json` GSD's own hook registration writes, plus a standalone `mcp_config.json` MCP-companion profile (Upgrade 2, dispatched alongside it). Replaces the old `finishPermissionWriter` field in the `runtime-config-adapter-registry` `REGISTRY` table. All 13 runtimes that write no permissions sidecar carry `null`.

#### `extendedHookEvents` — `string[]` over a closed event vocabulary

The per-runtime set of **bonus lifecycle events** beyond the coarse `hookEvents` dialect. Vocabulary:

```
SubagentStop | Stop | PreCompact | FileChanged | BeforeAgent | AfterAgent | BeforeModel
```

Values per runtime:
- `claude` → `[SubagentStop, Stop, PreCompact, FileChanged]`
- `qwen` → `[SubagentStop, Stop, PreCompact]`
- `gemini` → `[BeforeAgent, AfterAgent, BeforeModel]`
- all 13 others → `[]`

This replaces three hardcoded per-event guards in `applySettingsJsonHooks`: the `if (isQwen || runtime==='claude')` block (SubagentStop/Stop/PreCompact) and the `if (runtime==='claude')` block (FileChanged) and the `if (isGemini)` block (BeforeAgent/AfterAgent/BeforeModel). The loop now iterates `extendedHookEvents` for the active runtime; no per-runtime conditionals remain.

**Relationship to `hookEvents`:** `hookEvents` (the coarse 2-value dialect — `'claude'` vs `'gemini'`) governs the *event-name vocabulary* the hook adapter emits. `extendedHookEvents` governs the *additional lifecycle events* each runtime registers beyond the base set. They are independent: antigravity carries `hookEvents: 'gemini'` (so its hook bodies use Gemini event names) but `extendedHookEvents: []` — it does **not** receive the per-agent Gemini events (`BeforeAgent`/`AfterAgent`/`BeforeModel`), which are gemini-only.

#### `hooksSurface` is now load-bearing

The `hooksSurface === 'none'` value now drives the settings-json hook-skip path in `applySettingsJsonHooks`, replacing the former `isOpencode || isKilo` boolean guards. This is not a new axis — `hooksSurface` was already Decision 5 — but it is now actively consumed (load-bearing) rather than advisory.

### 8. Staged consumption — author registry-only, then drive install one axis at a time

The migration is staged the way phases 3–4 were (registry-only → consume incrementally → equivalence-proven no-op → retire the hardcoded branch). **Four of the original eight axes already live in dedicated modules** that `install.js` merely consumes, so driving them from the descriptor is per-axis and low-risk; the rest is staged behind a prerequisite and assembled last — **no big-bang `install()` rewrite**.

1. **5a — author the 16 descriptors** (`capabilities/<runtime>/capability.json`, `role: runtime`) registry-only; nothing consumes them. The generator already validates them; the `runtimes` index populates.
2. **5b — drive `configHome`** ← descriptor (`runtime-homes.cts` already centralizes it; swap its switch for a descriptor lookup). Smallest blast radius.
3. **5c — drive `commandStyle`** ← descriptor (`runtime-slash.cts`, 2 values). Trivial.
4. **5d — drive `artifactLayout`** ← descriptor (`runtime-artifact-layout.cts`, ADR-3660; this is ADR-3660's Phase 2 / #3664 — the largest LOC reduction).
5. **5e — drive `configFormat`** ← descriptor (`runtime-config-adapter-registry.cts`) **and close the `ConverterName` enum** (Decision 3). Model-catalog routing stays orthogonal — referenced by descriptor `name`, not an axis; codex's install-time model-embedding is an implementation detail of its converter, not a 7th axis.
6. **5f — extract `hooksSurface` into its own module, then drive it** ← descriptor. `hooks-surface` is the one axis still scattered across `install.js`; its module extraction is a prerequisite, exactly as ADR-3660 was for `artifactLayout`. **5f-completion (done):** `installSurface` drives the config-writing adapter in `runtime-config-adapter-registry` (#1055, retiring the hand-kept `REGISTRY` table); `extendedHookEvents` drives per-event hook registration in `applySettingsJsonHooks` (#1076, retiring the three hardcoded per-event guards); `hooksSurface === 'none'` is now load-bearing for the hook-skip path (replacing `isOpencode/isKilo` flags). `writesSharedSettings` and `permissionWriter` complete the adapter-selection and permissions-writer parameterisation (all four axes added to `validateRuntimeBody`).
7. **5g — materialize the `InstallPlan`** (ADR-58) — **DONE**: the install-level descriptor axes (`installSurface`, `writesSharedSettings`, `finishPermissionWriter`, `hookEvents`, `extendedHookEvents`, `hooksSurface`) are collected into one typed `InstallPlan` value by the exported `resolveInstallPlan(runtime)` in `runtime-config-adapter-registry`. `install()` and `finishInstall()` in `bin/install.js` now route through it. The spatial axes (`configHome`, `artifactLayout`, `commandStyle`) remain behind their self-resolving adapter modules (`runtime-homes` / `runtime-artifact-layout` / `runtime-slash`) as the execution adapters — consistent with the "adapters execute" pattern. Phase 5 is fully materialized.

Each rung is its own approved-enhancement + PR + equivalence proof. (`sandbox-tier`, codex-only, was scoped to ride along in 5e/5g, but neither rung delivered the drive — the InstallPlan capstone shipped with six axes and `sandboxTier` was not among them. It is now wired directly: `resolveInstallPlan` projects `sandboxTier`, and `installCodexConfig` gates per-agent `sandbox_mode` emission on `sandboxTier !== 'none'`. The per-agent mode table `CODEX_AGENT_SANDBOX` remains GSD agent policy — not a runtime-descriptor property — so it is intentionally NOT retired here; full removal of that registration-tax map is tracked under #1138 (phase-6 descriptor-residue removal). The gate is behaviourally a no-op while codex is the only runtime with a non-`none` tier.) **Irreducible first-party code, named not hidden:** the artifact converter *functions* remain first-party code, selected by the descriptor's closed `ConverterName` — the descriptor never embeds them.

### 9. Two axes: the descriptor dogfoods the *runtime* interface only

Two orthogonal axes were conflated under "third-party" in earlier ADRs (grilled against #956/#999):

- **Authorship / distribution** — *who wrote it & how it ships*: built-in (in-repo) vs third-party (installed). The welcoming, common word "plugin / third-party plugin" stays here, untouched.
- **Integration shape** — *where the code runs*: an in-host **Capability** (declarative artifacts + in-tree first-party code referenced by closed name) or a **Connected Capability** (brings its own external process / service / state — e.g. MemPalace's MCP server + database, #956).

All 16 runtimes are authored through the same descriptor (dogfooding) — but the descriptor dogfoods the **runtime-descriptor interface only**. It does **not** validate the third-party *feature-plugin* interface, because the hard feature plugins third parties actually write are **Connected Capabilities**, whose contract — MCP-server / external-process / backend-provider contributions + a §7 trust/load gate — **does not exist yet**. Third-party *runtime* loading stays purely additive (a loader + light trust gate over the descriptor: schema validation + write-confinement to the declared `configHome` + opt-in). The third-party *feature-plugin / Connected Capability* path is a **named, tracked gap**, not de-risked by this work; #956 is its design vehicle.

## Alternatives considered

1. **Keep per-runtime branches; just extract helpers** — rejected: leaves the ~18-site add-a-runtime tax and the scattering ADR-857 exists to end; no path to third-party runtimes.
2. **Open escape hatch / arbitrary code in the descriptor** (a `customInstall(fn)`) — rejected: violates the closed-vocabulary principle, reintroduces code-in-data, and breaks the third-party trust story. Hard shapes are absorbed by *adding a named primitive*, reviewed first-party.
3. **Big-bang `InstallPlan` materialization** (drive all axes at once) — rejected: `install.js` is ~287 branches; a single cutover can't be equivalence-proven incrementally. Per-axis staging (Decision 8) keeps every step a provable no-op, matching phases 3–4.
4. **A single `configHome` path string** — rejected: cannot express kilo's config≠skills split, antigravity/kimi probes, or env overrides without re-scattering logic; the structured value (Decision 1) is the minimal shape that absorbs all 16.

## Consequences

**Positive:** adding a runtime becomes authoring one `capability.json` (no `install.js` surgery); per-runtime knowledge lives in one declarative place; the third-party door is additive; `install.js` shrinks substantially (ADR-3660 alone projects ~250 lines off the artifact axis); the descriptor dogfoods the third-party *runtime* interface (it does **not** validate the third-party *feature-plugin* / Connected Capability interface — a separate, undesigned contract).

**Negative:** the closed vocabulary must grow (reviewed) when a genuinely new host shape appears — intentional friction, the trust boundary. The staged migration is many small PRs. The `sandboxTier` axis is thin (only codex non-`none`) and may feel speculative until a second sandboxed runtime appears.

**Neutral:** behavior is unchanged throughout (every axis cutover is equivalence-proven); model-catalog routing stays where it is, referenced by descriptor `name`.

## Out of scope

Authoring the 16 descriptors and the per-axis install cutovers (the impl phases — note: 5f-completion install-surface drives are **done**, see Decision 7a; 5g `InstallPlan` materialization is **done**, see Decision 8 step 7); third-party runtime loading (its own additive ADR + trust gate); the per-feature loop-hook wiring (phase-6 cleanup); moving feature `*.enabled` keys out of the central config-schema (phase-6 cleanup). The runtime-descriptor phase (phases 5a–5g) is fully complete.

- The **Connected Capability** contract (MCP-server / external-process / backend-provider contributions + the §7 trust/load gate) — future design, vehicle #956.
- The **hook-firing spike** — proving `loop.render-hooks` → workflow execution end-to-end with a *host-computed aggregate* (a phase-6-flavored de-risk that should land **before** phase-5 build, since #956/#999 both depend on it).
- The structural **"off means off"** rule (the host derives shared outputs from the active hook set; hooks add or are counted, never mutate host source) — an ADR-894 contribution-model concern, recorded there, not in this ADR.

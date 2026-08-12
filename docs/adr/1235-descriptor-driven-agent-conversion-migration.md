# ADR-1235: Migrate agent conversion to the descriptor-driven install path

- **Status:** Accepted
- **Date:** 2026-06-14
- **Issue:** #1235
- **Builds on:** [ADR-3660](3660-runtime-artifact-layout-module.md) (runtime artifact layout), [ADR-457](457-generated-cjs-single-source.md) (the `src/*.cts` build-at-publish tree the converters live in), [ADR-1016](1016-runtime-capability-descriptor.md) (runtime capability descriptor)
- **Relates to:** #1173 (implementation), #1175 (dead-converter cleanup, done), #1227 (partial `convertedAgentsKind` plumbing groundwork)

## Context

Agent installation is the last major artifact class in `install()` that does **not** flow through the descriptor-driven path established by ADR-3660 (`installRuntimeArtifacts` → `_copyStaged`, with each runtime's artifacts declared in the capability registry's `artifactLayout`). Skills and kimi-agents already flow through it. The claude-**local** `agents` kind is *declared* in the descriptor (raw-copy, `converter: null`), but production `install()` still produces claude-local agent output via the inline loop — the skills-runtime gate routes Claude through `installRuntimeArtifacts` only when `isGlobal` (`bin/install.js` ~9822/9829), and claude-local commands/agents go through the back-compat copy path. So agents for **every** runtime (claude included) are, in practice, converted and written by a **separate inline loop** in `bin/install.js` (currently lines ~10102–10249).

This was surfaced while attempting #1173: #1227 added the `convertedAgentsKind` plumbing to the layout module, but it is **inert in production** — no runtime descriptor declares an `agents` kind with a non-null `converter`, so `dispatchKindEntry` always routes to the raw-copy `agentsKind`. The plumbing is exercised only by `tests/runtime-converters.test.cjs` (folds former `feat-1173-agent-converters-descriptor`, consolidation epic #1969) against a synthetic registry.

A naive cutover (point descriptors at the extracted converters, delete the inline loop) **regresses installs for every runtime**, because the inline loop performs cross-cutting and runtime-specific pipeline steps that the descriptor agents path does not replicate, and because the extracted converters' signature cannot receive the context those steps require. Two of those behaviors have no converter function at all today. Because the migration touches install correctness across ~15 runtimes in the most-edited install module, the cutover strategy and the parity-test contract are architectural decisions worth recording before code.

### The two (really three) mechanisms today

1. **Descriptor path** — `installRuntimeArtifacts` (`bin/install.js`) → `resolveRuntimeArtifactLayout` (`src/runtime-artifact-layout.cts`) → per-kind `stage()` → `applyRuntimeContentRewritesInPlace` → `_copyStaged`. Live in production for skills and kimi-agents. A claude-**local** `agents` kind (`converter: null`, raw copy) is *declared* in the claude descriptor, but production does not route claude-local agents through `installRuntimeArtifacts` (only claude-*global* skills hit the layout path) — so the declared entry does not govern claude-local agent output today. Also note `installRuntimeArtifacts` applies `applyRuntimeContentRewritesInPlace` to skills/kimi-agents but **not** to the `agents` kind. `convertedAgentsKind` (`src/runtime-artifact-layout.cts:214–229`) exists and is dispatched (`:439–443`) but is unused by any real descriptor.

2. **Inline agent loop** — `bin/install.js` ~10102–10249. Runs for **all** runtimes except kimi (short-circuited; handled by the `kimi-agents` descriptor kind) and minimal mode. For skills-based runtimes it runs *after* `installRuntimeArtifacts` and is the **only** agent-install path for them. This is where the real per-runtime conversion happens.

3. **Codex TOML sidecar** — a *third*, separate path (`bin/install.js` ~5730–5750, `generateCodexAgentToml`) writes Codex agents' `.toml` sidecar (reading model overrides + effort), independent of both mechanisms above. Any "agents through the descriptor" story must account for it.

## Decision

Migrate agent conversion onto the descriptor path **incrementally, one runtime at a time, each cutover gated on byte-for-byte golden-output parity** — never as a single big-bang replacement (Gall's Law: evolve the working dual-path system, don't replace it wholesale). Concretely:

1. **Split the agent pipeline into cross-cutting steps and a runtime-specific converter.** The descriptor agents path applies the *cross-cutting* steps uniformly to every runtime (mirroring how skills already get `applyRuntimeContentRewritesInPlace` — which the `agents` kind does **not** get today), and delegates only the *runtime-specific* transform to the converter. Cross-cutting = path-prefix rewrite, `processAttribution`, `normalizeAgentBodyForRuntime`. Runtime-specific = the per-runtime frontmatter/format converter plus its scope/model/effort needs. **Preserve the inline loop's transform order**, because byte-parity depends on it: stale-cleanup → path-prefix rewrite → `processAttribution` → runtime converter/branding → claude `effort`/`disallowedTools` injection → body normalization → filename rename. Implementers must not silently inherit the skills ordering or the current single-arg `convertedAgentsKind` shape.

2. **Introduce a converter-context contract** so converters can replicate the runtime-specific behaviors the single-arg `(content) => string` signature cannot express (this signature is a leaky abstraction — it omits the context conversion actually needs).

3. **Build a golden-parity harness first**, capture the inline loop's current output per runtime as golden fixtures, then cut over each runtime only when the descriptor path reproduces its golden output byte-for-byte (Hyrum's Law: ~15 runtimes' installs depend on the *exact* current output, documented or not — preserve it).

4. **Delete each runtime's inline branch only after its parity gate is green**, and delete the inline loop entirely only when the last runtime (and the Codex TOML sidecar) has cut over.

### The parity behaviors the descriptor agents path must gain

The inline loop performs **ten** behaviors beyond raw copy (the issue listed seven; verification against `bin/install.js` found three more — Qwen/Hermes branding swaps, the Codex TOML sidecar, and stale-agent cleanup). The descriptor path must reproduce each, for the runtimes shown:

| # | Behavior | `bin/install.js` (approx.) | Applies to | Kind |
|---|---|---|---|---|
| a | Path-prefix rewrite (`~/.claude/` → `pathPrefix`) | 10154–10165 | all **except** copilot, antigravity (own rewrite) | cross-cutting |
| b | `processAttribution(content, getCommitAttribution(runtime))` | 10166 | all | cross-cutting |
| c | `normalizeAgentBodyForRuntime` (colon→hyphen `/gsd:` refs) | 10240 | claude, qwen, hermes | cross-cutting (gated set) |
| d | Claude `effort:` + `disallowedTools:` frontmatter injection | 10225–10232 | claude only | runtime-specific (needs agentName + targetDir) |
| e | Copilot `.agent.md` filename rename | 10241 | copilot only | runtime-specific (file-level, not content) |
| f | `isGlobal` scope arg to the converter | 10194–10196 | copilot, antigravity | runtime-specific (needs scope) |
| g | OpenCode per-agent model-override read + inject | 10168–10186 | opencode only | runtime-specific (needs agentName + targetDir) |
| h | Qwen/Hermes branding swaps (`Claude Code`/`.claude/`/`CLAUDE.md`) | 10210–10217 | qwen, hermes | runtime-specific — **no converter function exists today** |
| i | Codex `.toml` sidecar (reads model override + effort; emits `model_reasoning_effort` **only when a model is pinned**) | ~5730–5750, ~3167 | codex only | separate third path |
| j | Stale-agent cleanup: remove pre-existing `agents/gsd-*` before (re)install; minimal-mode Codex strips stale `[agents.gsd-*]` TOML (the full→minimal shrink) | ~10111, ~10126 | all (file cleanup); codex (toml) | cross-cutting pre-step |

### Converter-context contract

Today the extracted converters (`src/runtime-artifact-conversion.cts`) are `(content: string) => string` (a few accept an optional `isGlobal`), and `convertedAgentsKind` wraps them as `(content) => string`, discarding all other context. The contract enrichment passes a context object alongside `content`:

```
AgentConverterContext = {
  agentName: string;      // 'gsd-planner' — for effort, disallowedTools, model overrides
  runtime: string;        // for attribution + normalization predicate
  isGlobal: boolean;      // copilot/antigravity scope selection
  targetDir: string;      // to read effort/model-override/attribution user config
  cmdNames: string[];     // for body hyphen-normalization
  modelOverride?: string; // resolved opencode/codex per-agent override
  effort?: string;        // resolved claude per-agent effort
  disallowedTools?: string; // resolved claude read-only-agent tools
}
```

Cross-cutting steps (a, b, c) are applied by the descriptor pipeline for the appropriate runtime sets, so converters need context only for the runtime-specific steps (d–i). Resolving `modelOverride`/`effort`/`disallowedTools` at the descriptor boundary (where `targetDir` is known) keeps converters pure on `(content, ctx)`.

## Incremental cutover plan (each step gated on golden parity)

0. **Parity harness** — capture, per runtime, the inline loop's installed agent files as golden fixtures **for both full and minimal mode** (so the full→minimal shrink and stale-agent cleanup, behavior j, are covered), and add a test asserting the descriptor path's staged+converted output is byte-identical — including that re-installing over a stale `agents/gsd-*` set converges to the same result. This is the gate every subsequent step must pass.
1. **Trivial converters** (cursor, windsurf, augment, trae, codebuddy, cline) — single-arg converters; need only cross-cutting steps + the existing converter. Lowest risk; proves the split.
2. **Scope-aware** (copilot, antigravity) — thread `isGlobal`; copilot also needs the `.agent.md` rename (a descriptor file-name transform).
3. **Config-reading** (opencode model override; claude effort/disallowedTools) — resolve via context at the descriptor boundary.
4. **No-converter runtimes** (qwen, hermes) — add real `convertClaudeAgentTo{Qwen,Hermes}Agent` converters capturing today's branding swaps, then cut over.
5. **Codex** — fold the `.toml` sidecar into the descriptor (or declare it an explicit companion artifact); the `.md` + `.toml` must both reach parity.
6. **Delete the inline loop** once every runtime is green; remove the now-dead `isKimi`/minimal special-casing that referenced it.

### Cutover progress (#1575)

- **Step 0 (parity harness):** shipped in `tests/golden-parity-single-source.test.cjs` (folded from `tests/issue-1575-agent-descriptor-parity.test.cjs` in the #3336 test-hygiene sweep). Asserts `applySurface` output is byte-identical to `installRuntimeArtifacts` for all descriptor-driven runtimes. Covers stale-cleanup convergence (pre-existing legacy `.agent.md` pruned correctly).
- **Step 1 (trivial converters):** cursor, windsurf, augment, trae, codebuddy — install-path cutover complete (PR #1438); surface-path parity shipped (#1575: `applySurface` now builds `agentCtx` and passes it to `kind.stage()` for agents, applying path-rewrite + attribution + converter + normalize).
- **Step 2 (scope-aware):** copilot and antigravity — cutover complete (#1575: declared `agents` kind in `capability.json`, added to `_DESCRIPTOR_AGENTS_RUNTIMES`, copilot `.agent.md` rename handled in both `_copyStaged` and `_syncGsdDir`).
- **Cline:** deferred — rules-only local branch + local/global complication not handled by the descriptor-driven path.
- **Remaining:** steps 3–6 (config-reading, no-converter, codex, inline-loop deletion).

## Risks / trade-offs

- **Silent install regression** across ~15 runtimes is the dominant risk; the byte-for-byte golden gate is the mitigation, and per-runtime sequencing bounds the blast radius of any single step.
- **Context contract scope creep** — passing `targetDir` into staging couples conversion to user config reads. Mitigated by resolving the config-derived values (effort/model/attribution) *before* the converter and passing only resolved scalars.
- **Golden fixtures drift** — fixtures must be regenerated deliberately when agent source legitimately changes; treat fixture updates as reviewed changes, not auto-accepted.
- **Codex's third path** may not fit the single-artifact descriptor model cleanly; it may warrant a companion-artifact concept rather than being forced into the agents kind.

## Out of scope

- Implementing the migration (that is #1173 and its follow-ups; this ADR is the design gate).
- Changing agent *authoring* (`agents/*.md` source) or the `src/*.cts` build model (ADR-457).
- Kimi agents (already descriptor-driven via `kimi-agents`).

## Success criteria

- A documented contract (this ADR) approved before cutover code lands.
- A golden-parity harness exists and each runtime's cutover PR is gated on it.
- After the final step, `bin/install.js` has a single agent-install path (descriptor), the inline loop is deleted, and `convertedAgentsKind` is live for every converting runtime.

## Dependencies

- ADR-3660 (the descriptor/layout module being extended), ADR-457 (the `src/*.cts` tree the converters live in), ADR-1016 (capability descriptor that carries `artifactLayout`).
- #1173 (implementation tracker), #1227 (groundwork: `convertedAgentsKind`), #1175 (dead-converter cleanup, completed separately).

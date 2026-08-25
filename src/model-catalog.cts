/**
 * Model catalog — typed access to model-catalog.json.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/model-catalog.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */

import path from 'node:path';

// In .cts (CommonJS output) files, `require` is available as a global;
// we use it directly to load JSON candidates.
const _require: NodeRequire = require;

// Resolve model-catalog.json via a prioritised candidate list so the module
// works in every layout:
//
//   1. Co-located install path — gsd-core/bin/shared/model-catalog.json
//   2. GSD_MODEL_CATALOG env override
//
// A third candidate — `sdk/shared/model-catalog.json`, three levels up — used to
// sit between them. It was the legacy source-repo path kept as a fallback by the
// #3288 fix, whose contract was "check the co-located path FIRST, before the
// legacy source-repo path". ADR-0174 then retired the `@opengsd/gsd-sdk` package
// boundary and deleted the `sdk/` tree outright, so that candidate can no longer
// resolve in any layout: in a source repo there is no `sdk/`, and in an install
// layout it points at `~/.claude/sdk/shared/`, which the installer never writes
// (the original #3288 bug). It is removed rather than left as dead weight that
// implies a package boundary this repo no longer has.
const _catalogCandidates: string[] = [
  path.resolve(__dirname, '..', 'shared', 'model-catalog.json'),
  ...(process.env['GSD_MODEL_CATALOG'] ? [path.resolve(process.env['GSD_MODEL_CATALOG'])] : []),
];

/** Typed tier entry from model-catalog.json (model + optional reasoning_effort). */
export interface TierEntry {
  model: string;
  reasoning_effort?: string;
}

/** Per-agent model mapping in the catalog. */
export interface AgentMeta {
  golden: string;
  balanced: string;
  budget: string;
  phaseType: string;
  routingTier: string;
}

/** The shape of model-catalog.json. */
export interface ModelCatalog {
  profiles: string[];
  phaseTypes: string[];
  adaptiveTierMap: Record<string, string>;
  runtimeTierDefaults: Record<string, Record<string, TierEntry | null>>;
  providerPresets: Record<string, Record<string, Record<string, TierEntry | null>>>;
  agents: Record<string, AgentMeta>;
  codexModelEffort?: Record<string, string[]>;
}

let catalog: ModelCatalog | null = null;
let _catalogLastErr: Error | null = null;
for (const _p of _catalogCandidates) {
  try {
    catalog = _require(_p) as ModelCatalog;
    break;
  } catch (e) {
    const isMissingCandidate =
      (e && (e as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' && String((e as Error).message || '').includes(_p)) ||
      (e && (e as NodeJS.ErrnoException).code === 'ENOENT');
    if (!isMissingCandidate) throw e;
    _catalogLastErr = e as Error;
  }
}
if (!catalog) {
  throw new Error(
    `model-catalog.json not found. Tried:\n${_catalogCandidates.map((p) => `  ${p}`).join('\n')}\nLast error: ${_catalogLastErr?.message}`
  );
}

// After the throw guard above, catalog is guaranteed non-null.
const _catalog = catalog;

export { _catalog as catalog };

export const VALID_PROFILES: string[] = [..._catalog.profiles];
export const VALID_PHASE_TYPES: Set<string> = new Set(_catalog.phaseTypes);
export const VALID_AGENT_TIERS: Set<string> = new Set(Object.keys(_catalog.adaptiveTierMap));
// Catalog-derived so this can never drift from the resolver's tier gate:
// Object.values(adaptiveTierMap) === ['opus', 'sonnet', 'haiku'] today, plus 'inherit'.
export const VALID_TIERS: Set<string> = new Set([...Object.values(_catalog.adaptiveTierMap), 'inherit']);
// Same catalog-derived tier values as VALID_TIERS but WITHOUT 'inherit' — used
// by config-loader's runtime-override validation (model_profile_overrides /
// model_policy.runtime_tiers), which does not accept 'inherit' as a tier.
export const ADAPTIVE_TIER_VALUES: Set<string> = new Set(Object.values(_catalog.adaptiveTierMap));

/** Per-profile model slots for each agent. */
export interface AgentModelProfiles {
  quality: string;
  balanced: string;
  budget: string;
  adaptive: string;
}

export const MODEL_PROFILES: Record<string, AgentModelProfiles> = Object.fromEntries(
  Object.entries(_catalog.agents).map(([agent, meta]) => [agent, {
    quality: meta.golden,
    balanced: meta.balanced,
    budget: meta.budget,
    adaptive: _catalog.adaptiveTierMap[meta.routingTier],
  }])
);

export const AGENT_TO_PHASE_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(_catalog.agents).map(([agent, meta]) => [agent, meta.phaseType])
);

export const AGENT_DEFAULT_TIERS: Record<string, string> = Object.fromEntries(
  Object.entries(_catalog.agents).map(([agent, meta]) => [agent, meta.routingTier])
);

export const MODEL_ALIAS_MAP: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(_catalog.runtimeTierDefaults['claude'] ?? {}).map(([tier, entry]) => [tier, entry?.model])
);

export const RUNTIME_PROFILE_MAP: Record<string, Record<string, TierEntry>> = (() => {
  const result: Record<string, Record<string, TierEntry>> = {};
  for (const [runtime, tiers] of Object.entries(_catalog.runtimeTierDefaults)) {
    const filtered: Record<string, TierEntry> = {};
    for (const [tier, entry] of Object.entries(tiers)) {
      if (entry) filtered[tier] = entry;
    }
    if (Object.keys(filtered).length > 0) result[runtime] = filtered;
  }
  return result;
})();

export const KNOWN_RUNTIMES: Set<string> = new Set(Object.keys(_catalog.runtimeTierDefaults));
export const RUNTIMES_WITH_REASONING_EFFORT: Set<string> = new Set(
  Object.entries(_catalog.runtimeTierDefaults)
    .filter(([, tiers]) => Object.values(tiers).some((entry) => entry && entry.reasoning_effort))
    .map(([runtime]) => runtime)
);

export const PROVIDER_PRESETS: Record<string, Record<string, Record<string, TierEntry | null>>> =
  _catalog.providerPresets ?? {};

// ─── #3007 — Codex per-model effort capability ───────────────────────────────
//
// Codex's own `models.json` publishes `supported_reasoning_levels` per model and
// rejects an unsupported level at request time, so GSD must be conservative
// about what it sends: read the ceiling as DATA from the catalog (never
// branch on model id in code) and fall back to the family baseline for any
// model the catalog doesn't know about.
// (b) A malformed catalog entry (e.g. a non-array value like `"gpt-x": 5`) must
// degrade to "ignore that entry", never throw — model-catalog.cjs is required
// across the whole CLI, so one bad JSON value must not kill every command.
// `new Set(5)` would throw at module load; filter to array values first.
export const CODEX_MODEL_EFFORT: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(_catalog.codexModelEffort ?? {})
    .filter(([, levels]) => Array.isArray(levels))
    .map(([model, levels]) => [model, new Set(levels)])
);
// (a) `??` only catches null/undefined. A malformed `"_baseline": null` still
// produces `new Set(null)` above — an empty Set, which is truthy — so a bare
// `??` fallback would never fire and every level would silently lose its
// advertised set (every effort would render as `value: null`). Guard on
// `.size > 0` so an empty/missing/malformed baseline always falls back to the
// hardcoded floor instead of failing open.
const CODEX_EFFORT_BASELINE: Set<string> =
  CODEX_MODEL_EFFORT['_baseline'] && CODEX_MODEL_EFFORT['_baseline'].size > 0
    ? CODEX_MODEL_EFFORT['_baseline']
    : new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function advertisedCodexEffort(model: string | null | undefined): Set<string> {
  if (typeof model !== 'string' || model.length === 0) return CODEX_EFFORT_BASELINE;
  return Object.prototype.hasOwnProperty.call(CODEX_MODEL_EFFORT, model) ? CODEX_MODEL_EFFORT[model] : CODEX_EFFORT_BASELINE;
}

// The full universal effort ladder, low-to-high. Used only to find "the
// nearest advertised level below" when a requested level isn't supported —
// never to invent behaviour for a level that isn't on it at all.
const EFFORT_LADDER: string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// KNOWN_PROVIDERS excludes 'generic' — it is a sentinel (all null entries) that
// forces users to supply model IDs via model_profile_overrides. It is not a
// real catalog-backed provider (#49).
export const KNOWN_PROVIDERS: Set<string> = new Set(
  Object.entries(PROVIDER_PRESETS)
    .filter(([, tiers]) =>
      Object.values(tiers).some((budgets) =>
        budgets && Object.values(budgets).some((entry) => entry && entry.model)
      )
    )
    .map(([name]) => name)
);

// ─── #3241 — Anthropic-flavored model detection ──────────────────────────────
//
// Moved here from src/model-resolver.cts (the "seam decision" in
// .gsd/phase/feat-3241-codex-omit-model-by-default/40-design.md): this leaf
// module is the one common dependency both model-resolver and the (layering-
// restricted) install-time Codex-posture checks can share without pulling
// model-resolver's config-loader dependency chain into a "pure read/verify"
// caller. model-resolver re-exports both names for back-compat.
//
// #2310 — True if `model` is an Anthropic-flavored value that must never appear as a
// Codex agent `.toml` `model`. Two forms: (a) a bare Claude Agent-tool tier alias
// (opus/sonnet/haiku/fable — CLAUDE_AGENT_ALIASES below); (b) any Claude model id in
// any provider namespacing — `claude-*`, `anthropic/claude-*`, `us.anthropic.claude-*`
// (the forms the catalog assigns to opencode/hermes/kilo, reachable on a Codex .toml
// via the runtime-resolver path). No OpenAI/Codex model id contains "claude", so a
// case-insensitive substring test is a safe, exhaustive guard for (b). Codex/ChatGPT
// rejects all of these.
export const CLAUDE_AGENT_ALIASES: Set<string> = new Set(['opus', 'sonnet', 'haiku', 'fable']);

export function isAnthropicFlavoredModel(model: unknown): boolean {
  return typeof model === 'string' && (CLAUDE_AGENT_ALIASES.has(model) || model.toLowerCase().includes('claude'));
}

export function nextTier(currentTier: string): string | null {
  const order = ['light', 'standard', 'heavy'];
  const idx = order.indexOf(String(currentTier));
  if (idx === -1) return null;
  return order[Math.min(idx + 1, order.length - 1)];
}

export function formatAgentToModelMapAsTable(agentToModelMap: Record<string, string>): string {
  const agentWidth = Math.max('Agent'.length, ...Object.keys(agentToModelMap).map((a) => a.length));
  const modelWidth = Math.max('Model'.length, ...Object.values(agentToModelMap).map((m) => m.length));
  const sep = '─'.repeat(agentWidth + 2) + '┼' + '─'.repeat(modelWidth + 2);
  const header = ` ${'Agent'.padEnd(agentWidth)} │ ${'Model'.padEnd(modelWidth)}`;
  let out = `${header}\n${sep}\n`;
  for (const [agent, model] of Object.entries(agentToModelMap)) {
    out += ` ${agent.padEnd(agentWidth)} │ ${model.padEnd(modelWidth)}\n`;
  }
  return out;
}

export function getAgentToModelMapForProfile(normalizedProfile: string): Record<string, string> {
  const profile = VALID_PROFILES.includes(normalizedProfile) ? normalizedProfile : 'balanced';
  const out: Record<string, string> = {};
  for (const [agent, profiles] of Object.entries(MODEL_PROFILES)) {
    const profilesRec = profiles as unknown as Record<string, string>;
    out[agent] = profile === 'inherit' ? 'inherit' : (profilesRec[profile] ?? profiles.balanced);
  }
  return out;
}

// ─── Effort rendering ────────────────────────────────────────────────────────

export interface EffortSpec {
  param: string;
  channel: string;
  supported: Set<string>;
  clamp(level: string): string;
}

export const EFFORT_RENDERING: Record<string, EffortSpec> = {
  claude: {
    param: 'output_config.effort',
    channel: 'frontmatter',
    supported: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
    clamp(level: string): string {
      if (level === 'minimal') return 'low';
      return level;
    },
  },
  codex: {
    // #3007: 'max' and 'minimal' are stale here — Codex's per-model table
    // (CODEX_MODEL_EFFORT above) is now the source of truth for what a given
    // model actually advertises, and every model in the family baseline DOES
    // advertise 'max' (no model advertises 'minimal'). This runtime-level
    // spec is kept in sync with the family baseline so the two tables can
    // never disagree; renderEffortForRuntime layers the per-model ceiling
    // (and the 'ultra' policy rejection) on top of it.
    // KEEP IN SYNC with EFFORT_ARGV.codex below — same family baseline, two
    // channels (install-time vs invocation-time); they must never diverge.
    param: 'model_reasoning_effort',
    channel: 'api',
    supported: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
    clamp(level: string): string {
      if (level === 'minimal') return 'low';
      return level;
    },
  },
};

export interface RenderedEffort {
  value: string | null;
  param: string | null;
  channel: string | null;
  /** The level as originally asked for. */
  requested?: string;
  /** true ONLY when value !== requested. */
  clamped?: boolean;
  /** Why, when clamped or rejected; null otherwise. */
  reason?: string | null;
}

// ─── Invocation-time (argv) effort rendering ─────────────────────────────────
//
// ADR-1239 amendment (#2481) / ADR-443 path (a). EFFORT_RENDERING above covers the
// two INSTALL-TIME channels (`frontmatter`, `api`) — effort baked into a generated
// artifact. This table covers the INVOCATION-TIME channel: the argument appended to
// a host CLI spawned as a subprocess.
//
// WHETHER to emit is not decided here — it is the negotiated `effortSurface` axis on
// the host's descriptor (`argv` | `none`). This table only knows the
// syntax for hosts whose surface is `argv`. A host absent from this table renders
// null, so an undeclared or undocumented host silently gets nothing rather than a
// guessed flag.
export interface EffortArgvSpec {
  /** Render the argv fragment for an already-clamped effort level. */
  render(level: string): string[];
  /** Levels this CLI accepts; anything else clamps via `clamp` first. */
  supported: Set<string>;
  clamp(level: string): string;
}

export const EFFORT_ARGV: Record<string, EffortArgvSpec> = {
  // Verified against `claude --help`: `--effort <level>`.
  claude: {
    render: (level: string): string[] => ['--effort', level],
    supported: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
    clamp: (level: string): string => (level === 'minimal' ? 'low' : level),
  },
  // Verified against `opencode run --help`: `--variant` — "model variant
  // (provider-specific reasoning effort, e.g., high, max, minimal)".
  opencode: {
    render: (level: string): string[] => ['--variant', level],
    supported: new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    clamp: (level: string): string => level,
  },
  // First-party Codex docs: `model_reasoning_effort` is a config-only key with no
  // dedicated flag, so the generic `-c key=value` override is the only argv route.
  // #3007: KEEP IN SYNC with EFFORT_RENDERING.codex above — this table must match
  // the family baseline exactly (no 'minimal', 'max' passes through unclamped),
  // otherwise the argv channel and the install-time channel disagree about the
  // same runtime's capability.
  codex: {
    render: (level: string): string[] => ['-c', `model_reasoning_effort=${level}`],
    supported: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
    clamp: (level: string): string => (level === 'minimal' ? 'low' : level),
  },
};

export interface RenderedEffortArgv {
  argv: string[];
  value: string | null;
  host: string;
}

/**
 * Clamp a universal effort level to what a host actually accepts, or null.
 *
 * #3706 — extracted from `renderEffortArgv` so the two effort CHANNELS can share
 * one capability table without one pretending to be the other. `EFFORT_ARGV[host]`
 * describes what levels the host understands (`supported` + `clamp`); whether that
 * reaches the host as a CLI flag or as a baked frontmatter key is the caller's
 * business. The install-time OpenCode `variant:` writer needs the former without
 * the latter, and hardcoding `'argv'` at that call site to borrow this logic read
 * as if the frontmatter key were gated on the invocation-time axis. It is not —
 * claude declares `effortSurface: "argv"` and independently bakes an `effort:` key.
 *
 * Returns null for a level the host does not accept, which every caller treats as
 * "emit nothing". `inherit` lands here too: per #3533 (10d) it is not a wire level
 * on any runtime, so it is in no `supported` set and must never be written out.
 */
export function clampEffortForHost(host: string, universalEffort: string): string | null {
  // Own-property lookup only: a plain `EFFORT_ARGV[host]` resolves `__proto__`
  // and friends to inherited members that carry no clamp/render.
  if (typeof host !== 'string' || !Object.prototype.hasOwnProperty.call(EFFORT_ARGV, host)) return null;
  const spec = EFFORT_ARGV[host];
  if (!spec || typeof spec.clamp !== 'function') return null;
  if (typeof universalEffort !== 'string' || universalEffort.length === 0) return null;
  const clamped = spec.clamp(universalEffort);
  return spec.supported.has(clamped) ? clamped : null;
}

/**
 * Render the invocation-time effort argument for a host.
 *
 * `effortSurface` is the host's negotiated axis value. Only `argv` produces an
 * argument; `none`, `undocumented`, and anything unrecognised produce nothing.
 * Never throws.
 */
export function renderEffortArgv(
  host: string,
  universalEffort: string,
  effortSurface: string | null | undefined,
): RenderedEffortArgv {
  const empty: RenderedEffortArgv = { argv: [], value: null, host };
  if (effortSurface !== 'argv') return empty;
  // Own-property lookup only. A plain `EFFORT_ARGV[host]` resolves `__proto__`
  // (and `constructor`/`toString`) to inherited members, which are truthy but
  // carry no `clamp`/`render` — a hostile host id would throw instead of
  // degrading. The host id reaches here from a descriptor, i.e. untrusted JSON.
  // #3706: the clamp/supported half lives in clampEffortForHost so the
  // install-time channel can reuse it; this function keeps the axis gate and
  // the argv rendering. One table, one clamp, two channels.
  const clamped = clampEffortForHost(host, universalEffort);
  if (clamped === null) return empty;
  const spec = EFFORT_ARGV[host];
  if (typeof spec.render !== 'function') return empty;
  return { argv: spec.render(clamped), value: clamped, host };
}

/**
 * Render a universal effort string for a specific runtime.
 *
 * `model` (#3007) is consulted ONLY for codex: Codex's per-model
 * `supported_reasoning_levels` means the same universal level can be a clean
 * pass-through on one model and a clamp (or, for 'ultra', an outright
 * rejection) on another. Every other runtime ignores the third argument
 * entirely — passing a model id to claude changes nothing.
 */
export function renderEffortForRuntime(runtime: string, universalEffort: string, model?: string | null): RenderedEffort {
  // #3533 (10d): 'inherit' is not a wire level on ANY runtime — it means
  // "omit the key / pass no argument and follow the session/host default".
  // Renderers must never emit it as a literal; null param/channel tells
  // resolve-execution consumers there is no propagation. Never measured
  // against any supported set.
  if (universalEffort === 'inherit') {
    return { value: 'inherit', param: null, channel: null, requested: 'inherit', clamped: false, reason: null };
  }
  const spec = EFFORT_RENDERING[runtime];
  if (!spec) {
    return { value: universalEffort, param: null, channel: null, requested: universalEffort, clamped: false, reason: null };
  }

  if (runtime === 'codex') {
    // #2167 — 'ultra' turns on Codex's automatic task delegation, which would
    // let Codex spawn agents underneath GSD's own orchestration. GSD rejects
    // it unconditionally as a POLICY call, never as a capability clamp — this
    // holds even for a model (e.g. gpt-5.6-sol) that DOES advertise 'ultra',
    // so it is never softened down to 'max'.
    if (universalEffort === 'ultra') {
      return {
        value: null,
        param: null,
        channel: null,
        requested: 'ultra',
        clamped: false,
        reason: "'ultra' turns on Codex's automatic task delegation, which would let Codex spawn agents underneath GSD's own orchestration (#2167); GSD rejects it regardless of what the model advertises.",
      };
    }

    const allowed = advertisedCodexEffort(model);
    if (allowed.has(universalEffort)) {
      return { value: universalEffort, param: spec.param, channel: spec.channel, requested: universalEffort, clamped: false, reason: null };
    }

    const idx = EFFORT_LADDER.indexOf(universalEffort);
    if (idx === -1) {
      // Not on the ladder at all (e.g. 'MAX') — preserve prior behaviour:
      // fall through to the runtime-level clamp rather than inventing new
      // handling for input the ladder doesn't recognize.
      return { value: spec.clamp(universalEffort), param: spec.param, channel: spec.channel, requested: universalEffort, clamped: false, reason: null };
    }
    // Every model's advertised set is a contiguous run up to 'max' (or 'ultra'
    // for sol, already handled above), so the only unsupported level in
    // practice is 'minimal' — below every model's floor. Walk UP the ladder
    // to the nearest level the model actually advertises (its floor): there
    // is nothing below 'minimal' to fall back to.
    // Walking UP is safe today only because every advertised set floors at
    // 'low' — a future model whose floor is, say, 'high' would silently turn
    // a requested 'low' into 'high': MORE reasoning and MORE cost than asked
    // for, with no error. `clamped`/`reason` below is what makes that
    // escalation visible to a caller instead of a silent cost surprise, which
    // is why those fields are not optional decoration.
    for (let i = idx + 1; i < EFFORT_LADDER.length; i++) {
      const candidate = EFFORT_LADDER[i];
      // 'ultra' is never a valid clamp target: it would re-enter, by the back
      // door, the delegation mode the #2167 rejection above exists to keep
      // out. A clamp may never produce a value that a direct request for
      // that same value would have refused.
      if (candidate === 'ultra') {
        continue;
      }
      if (allowed.has(candidate)) {
        return {
          value: candidate,
          param: spec.param,
          channel: spec.channel,
          requested: universalEffort,
          clamped: true,
          reason: `requested '${universalEffort}' is not in ${model ? `${model}'s` : "the codex family baseline's"} advertised reasoning levels; clamped up to its floor, '${candidate}'.`,
        };
      }
    }
    // No advertised level at or above the request either (shouldn't happen
    // given today's catalog data, but never throw): reject rather than emit
    // an unsupported level.
    return {
      value: null,
      param: null,
      channel: null,
      requested: universalEffort,
      clamped: false,
      reason: `requested '${universalEffort}' is not in ${model ? `${model}'s` : "the codex family baseline's"} advertised reasoning levels, and no advertised level is available either.`,
    };
  }

  const value = spec.clamp(universalEffort);
  return {
    value,
    param: spec.param,
    channel: spec.channel,
    requested: universalEffort,
    clamped: value !== universalEffort,
    reason: value !== universalEffort ? `requested '${universalEffort}' clamped to '${value}' for ${runtime}.` : null,
  };
}

/**
 * #3531 (10c) — Merge a config `effort.routing_tier_defaults` block over the
 * manifest tier defaults instead of replacing them. A partial config must not
 * discard built-ins: per tier, a valid override value wins and an invalid one
 * is ignored so the manifest value for that tier surfaces (ADR-443 D1's
 * "invalid values fall through" holds within the merged layer).
 *
 * Pure: returns a new object and never mutates either input — the manifest
 * constants (`CANONICAL_CONFIG_DEFAULTS`, the catalog cache) stay frozen. The
 * validator is injected because `EFFORT_SET` lives in model-resolver, which
 * imports this leaf (a reverse import would be a cycle); both effort
 * resolvers pass their own `(v) => typeof v === 'string' && EFFORT_SET.has(v)`.
 */
export function mergeEffortTierDefaults(
  manifest: Record<string, string> | null | undefined,
  override: unknown,
  isValid: (v: unknown) => boolean,
): Record<string, string> {
  const merged: Record<string, string> = { ...(manifest || {}) };
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    for (const [tier, value] of Object.entries(override as Record<string, unknown>)) {
      // House pollution guard (mirrors _deepMergeConfig in config-loader): the
      // string-only validator already makes these inert, but an explicit skip
      // keeps this merge safe even if a caller's validator is ever relaxed.
      if (tier === '__proto__' || tier === 'constructor' || tier === 'prototype') continue;
      if (isValid(value)) merged[tier] = value as string;
    }
  }
  return merged;
}

// ─── Fast mode propagation ───────────────────────────────────────────────────
export const RUNTIMES_WITH_FAST_MODE: Set<string> = new Set(['api']);

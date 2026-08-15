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
    param: 'model_reasoning_effort',
    channel: 'api',
    supported: new Set(['minimal', 'low', 'medium', 'high', 'xhigh']),
    clamp(level: string): string {
      if (level === 'max') return 'xhigh';
      return level;
    },
  },
};

export interface RenderedEffort {
  value: string;
  param: string | null;
  channel: string | null;
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
  codex: {
    render: (level: string): string[] => ['-c', `model_reasoning_effort=${level}`],
    supported: new Set(['minimal', 'low', 'medium', 'high', 'xhigh']),
    clamp: (level: string): string => (level === 'max' ? 'xhigh' : level),
  },
};

export interface RenderedEffortArgv {
  argv: string[];
  value: string | null;
  host: string;
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
  if (typeof host !== 'string' || !Object.prototype.hasOwnProperty.call(EFFORT_ARGV, host)) return empty;
  const spec = EFFORT_ARGV[host];
  if (!spec || typeof spec.clamp !== 'function' || typeof spec.render !== 'function') return empty;
  if (typeof universalEffort !== 'string' || universalEffort.length === 0) return empty;
  const clamped = spec.clamp(universalEffort);
  if (!spec.supported.has(clamped)) return empty;
  return { argv: spec.render(clamped), value: clamped, host };
}

/**
 * Render a universal effort string for a specific runtime.
 */
export function renderEffortForRuntime(runtime: string, universalEffort: string): RenderedEffort {
  // #3533 (10d): 'inherit' is not a wire level on ANY runtime — it means
  // "omit the key / pass no argument and follow the session/host default".
  // Renderers must never emit it as a literal; null param/channel tells
  // resolve-execution consumers there is no propagation.
  if (universalEffort === 'inherit') {
    return { value: 'inherit', param: null, channel: null };
  }
  const spec = EFFORT_RENDERING[runtime];
  if (!spec) {
    return { value: universalEffort, param: null, channel: null };
  }
  return {
    value: spec.clamp(universalEffort),
    param: spec.param,
    channel: spec.channel,
  };
}

// ─── Fast mode propagation ───────────────────────────────────────────────────
export const RUNTIMES_WITH_FAST_MODE: Set<string> = new Set(['api']);

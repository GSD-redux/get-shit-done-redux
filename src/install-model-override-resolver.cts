/**
 * install-model-override-resolver — install-time per-agent model-override
 * resolution (#2256 / #2794), extracted from the package-root `bin/install.js`
 * (#2875 Part 2 / J8).
 *
 * bin/install.js's inline agent-staging loop duplicated this EXACT precedence
 * chain across two runtime branches (OpenCode ~24 lines, Kilo ~24 lines) —
 * `model_overrides[agent]` > `model_profile_overrides.<runtime>.<tier>` > omit.
 * Extracted here — a `src/*.cts` module compiled into the shipped
 * `gsd-core/bin/lib/` tree, mirroring `install-effort-resolver.cts`'s existing
 * precedent (#2071) — so the descriptor-driven agents pipeline
 * (`convertedAgentsKind` / `stageAgentsForRuntimeWithConverter`) and
 * bin/install.js's own callers resolve through the SAME code. A single source
 * of truth makes the two paths diverge only if this module changes, not
 * silently across two hand-maintained copies (the Generative Fix Divergence
 * class CLAUDE.md's "Known Defects" section warns about).
 *
 * `readGsdGlobalModelOverrides` / `readGsdEffectiveModelOverrides` /
 * `readGsdRuntimeProfileResolver` are impure (config-file reads);
 * `resolveAgentModelOverride` is pure given their pre-resolved outputs.
 *
 * #2875 defect fix: this module is on the `installRuntimeArtifacts` call tree
 * (reached from `runtime-artifact-layout.cts`'s agents-kind `stage()` for the
 * opencode/kilo converters) — every fs touch below routes through
 * `installFs()` (install-fs-adapter.cts), matching `retired-artifact-cleanup.cts`
 * / `user-artifact-staging.cts`'s existing precedent, instead of calling
 * `node:fs` directly. A raw `fs` call here silently bypassed a fake adapter
 * injected via `withInstallFs`/`installRuntimeArtifacts(..., { fs })`,
 * exactly the class of bug those two modules were fixed for.
 */
import path from 'node:path';
import os from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- install-fs-adapter.cjs is an export= CommonJS module
import installFsAdapter = require('./install-fs-adapter.cjs');
const { installFs } = installFsAdapter;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- install-effort-resolver.cjs is an export= CommonJS module
import installEffortResolver = require('./install-effort-resolver.cjs');
const { _readGsdConfigFile, _findAncestorGsdConfigPath } = installEffortResolver as {
  _readGsdConfigFile: (absPath: string, label: string) => Record<string, unknown> | null;
  _findAncestorGsdConfigPath: (targetDir: string) => string | null;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- model-catalog.cjs is an export= CommonJS module
import modelCatalog = require('./model-catalog.cjs');
const { MODEL_PROFILES: GSD_MODEL_PROFILES } = modelCatalog as unknown as { MODEL_PROFILES: Record<string, Record<string, string>> };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- model-resolver.cjs is an export= CommonJS module
import modelResolverModule = require('./model-resolver.cjs');
const { resolveTierEntry: gsdResolveTierEntry, resolveModelPolicy: gsdResolveModelPolicy } = modelResolverModule as {
  resolveTierEntry: (opts: { runtime: string; tier: string; overrides: unknown }) => { model?: string } | null;
  resolveModelPolicy: (policy: unknown, tier: string | null | undefined) => string | null;
};

interface ReadOptions {
  homedir?: () => string;
}

interface RuntimeProfileResolver {
  runtime: string;
  resolve: (agentName: string) => { model?: string; reasoning_effort?: string } | null;
}

/**
 * Read `model_overrides` from `~/.gsd/defaults.json` at install time.
 * Returns an object mapping agent names to model IDs, or null if the file
 * doesn't exist or has no `model_overrides` entry.
 *
 * Mirrors bin/install.js's prior local `readGsdGlobalModelOverrides` exactly
 * (silent try/catch — no stderr warning on malformed JSON, unlike
 * `_readGsdConfigFile`'s effort-config sibling — preserved for byte-parity).
 */
function readGsdGlobalModelOverrides(options: ReadOptions = {}): Record<string, string> | null {
  try {
    const home = options.homedir ? options.homedir() : os.homedir();
    const defaultsPath = path.join(home, '.gsd', 'defaults.json');
    if (!installFs().existsSync(defaultsPath)) return null;
    const raw = installFs().readFileSync(defaultsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { model_overrides?: unknown };
    const overrides = parsed.model_overrides;
    if (!overrides || typeof overrides !== 'object') return null;
    return overrides as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Effective per-agent `model_overrides` for the install path.
 *
 * Merges `~/.gsd/defaults.json` (global) with per-project
 * `<project>/.planning/config.json`. Per-project keys win on conflict; keys
 * present in only one source are preserved from that source (#2256).
 *
 * `targetDir` is the consuming runtime's install root (walks up to find
 * `.planning/`). When `targetDir` is null/undefined only the global file is
 * consulted.
 *
 * Returns a plain `{ agentName: modelId }` object, or `null` when neither
 * source defines `model_overrides`.
 */
function readGsdEffectiveModelOverrides(targetDir: string | null = null, options: ReadOptions = {}): Record<string, string> | null {
  const global = readGsdGlobalModelOverrides(options);

  let projectOverrides: Record<string, string> | null = null;
  if (targetDir) {
    // #2875 defect fix (Generative Fix Divergence): the 8-deep upward walk to
    // `.planning/config.json` is single-sourced in install-effort-resolver.cts
    // (`_findAncestorGsdConfigPath`) — this module was itself extracted FROM
    // that one to stop duplicating shared install-time config logic, so a
    // second hand-rolled copy of the walk here defeated the point.
    const candidate = _findAncestorGsdConfigPath(targetDir);
    if (candidate) {
      try {
        const parsed = JSON.parse(installFs().readFileSync(candidate, 'utf-8')) as { model_overrides?: unknown };
        if (parsed && typeof parsed === 'object' && parsed.model_overrides && typeof parsed.model_overrides === 'object') {
          projectOverrides = parsed.model_overrides as Record<string, string>;
        }
      } catch {
        // Malformed config.json — fall back to global; readGsdRuntimeProfileResolver
        // surfaces a parse warning via _readGsdConfigFile already.
      }
    }
  }

  if (!global && !projectOverrides) return null;
  // Per-project wins on conflict; preserve non-conflicting global keys.
  return { ...(global || {}), ...(projectOverrides || {}) };
}

type AgentTools = Record<string, string[]>;

function readGsdAgentTools(config: Record<string, unknown> | null): AgentTools | null {
  const raw = config?.agent_tools;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const result: AgentTools = {};
  for (const [selector, value] of Object.entries(raw as Record<string, unknown>)) {
    // An explicitly present selector always has a verdict. Invalid values are
    // empty so a project config cannot accidentally restore a global grant.
    result[selector] = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0
          && !entry.endsWith(':')
          && !/[\s\u0000-\u001F\u007F-\u009F,#"'\u2028\u2029]/.test(entry))
      : [];
  }
  return result;
}

/**
 * Resolve valid install-time `agent_tools` grants from global defaults and
 * the nearest project config. Project selectors replace only matching global
 * selectors; malformed whole files remain harmless absence like the existing
 * model override resolver.
 */
function readGsdEffectiveAgentTools(targetDir: string | null = null, options: ReadOptions = {}): AgentTools | null {
  const home = options.homedir ? options.homedir() : os.homedir();
  const globalConfig = _readGsdConfigFile(path.join(home, '.gsd', 'defaults.json'), 'global defaults');

  let projectConfig: Record<string, unknown> | null = null;
  if (targetDir) {
    const candidate = _findAncestorGsdConfigPath(targetDir);
    if (candidate) {
      projectConfig = _readGsdConfigFile(candidate, 'project config');
    }
  }

  const global = readGsdAgentTools(globalConfig);
  const project = readGsdAgentTools(projectConfig);
  if (projectConfig
    && Object.prototype.hasOwnProperty.call(projectConfig, 'agent_tools')
    && project === null) return {};
  if (!global && !project) return null;
  return { ...(global || {}), ...(project || {}) };
}

interface RuntimeProfileMergedConfig {
  runtime: string | null;
  model_profile: string;
  model_profile_overrides: unknown;
  /**
   * #3705: the provider-neutral policy (#49). Install-time never read it, so a
   * project configured for a non-Anthropic provider had its agent frontmatter
   * rebaked to catalog `anthropic/claude-*` IDs on every update while
   * dispatch-time resolution honoured the policy correctly — two answers from
   * one config, and only the frontmatter is what a spawn actually uses.
   */
  model_policy: unknown;
}

/**
 * Build a runtime-aware tier resolver for the install path (#2517).
 *
 * Probes BOTH per-project `<targetDir>/.planning/config.json` AND
 * `~/.gsd/defaults.json`, with per-project keys winning over global.
 *
 * Returns null if no `runtime` is configured, if `model_profile` is
 * `inherit`, or if no project config is reachable AND `~/.gsd/defaults.json`
 * declares no `model_profile` (#3543 — an unverifiable profile is never
 * baked, letting the runtime's own default/session model govern).
 */
function readGsdRuntimeProfileResolver(targetDir: string | null = null): RuntimeProfileResolver | null {
  const homeDefaults = _readGsdConfigFile(
    path.join(os.homedir(), '.gsd', 'defaults.json'),
    '~/.gsd/defaults.json',
  );

  // #2875 defect fix (Generative Fix Divergence): same shared walk as
  // readGsdEffectiveModelOverrides above — see that call site's comment.
  let projectConfig: Record<string, unknown> | null = null;
  if (targetDir) {
    const candidate = _findAncestorGsdConfigPath(targetDir);
    if (candidate) projectConfig = _readGsdConfigFile(candidate, '.planning/config.json');
  }

  const merged: RuntimeProfileMergedConfig = {
    runtime:
      (projectConfig && (projectConfig.runtime as string | undefined)) ||
      (homeDefaults && (homeDefaults.runtime as string | undefined)) ||
      null,
    model_profile:
      (projectConfig && (projectConfig.model_profile as string | undefined)) ||
      (homeDefaults && (homeDefaults.model_profile as string | undefined)) ||
      'balanced',
    model_profile_overrides:
      (projectConfig && projectConfig.model_profile_overrides) ||
      (homeDefaults && homeDefaults.model_profile_overrides) ||
      null,
    // #3705: same project-wins-over-home precedence as every other key here.
    model_policy:
      (projectConfig && projectConfig.model_policy) ||
      (homeDefaults && homeDefaults.model_policy) ||
      null,
  };

  if (!merged.runtime) return null;

  if (!projectConfig && !(homeDefaults && homeDefaults.model_profile)) {
    return null;
  }

  const profile = String(merged.model_profile).toLowerCase();
  if (profile === 'inherit') return null;

  const runtime = merged.runtime;
  return {
    runtime,
    resolve(agentName: string) {
      const agentModels = GSD_MODEL_PROFILES[agentName];
      if (!agentModels) return null;
      const tier = agentModels[profile] || agentModels.balanced;
      if (!tier) return null;
      // #3705: policy sits between the per-agent override and the tier table —
      // the position dispatch uses. Measured against `query resolve-model` on the
      // same config: policy-only -> the policy model; tier-overrides-only -> the
      // override; BOTH -> the policy model. So policy outranks
      // `model_profile_overrides`, and an explicit `model_overrides[agent]`
      // (applied by resolveAgentModelOverride below) outranks policy.
      //
      // Calls the exported owner (#49) rather than re-deriving tier -> model here:
      // a second implementation of that mapping is the very divergence this issue
      // is, one layer down. A null from it (unknown provider, missing tier key, a
      // `runtime_tiers` miss) falls through to the tier table — never to null,
      // which would omit a frontmatter key that used to be written.
      // The policy object must carry the effective runtime before it is resolved.
      // `resolveModelPolicy`'s `runtime_tiers` branch reads `policy['runtime']`, but
      // the documented config shape (docs/CONFIGURATION.md) puts `runtime` at the
      // TOP level and keeps only `provider`/`runtime_tiers` inside `model_policy`.
      // Dispatch injects it — `{ ...config.model_policy, runtime: effectiveRuntime }`
      // (model-resolver.cts) — and passing the policy unmodified here silently
      // skipped `runtime_tiers` entirely, falling through to the flat hi/med/lo keys
      // or the catalog tier. That is the same "catalog Anthropic ID baked over a
      // configured provider" defect this fix exists to close, so the injection is
      // mirrored rather than assumed.
      const policyForRuntime = merged.model_policy
        ? { ...(merged.model_policy as Record<string, unknown>), runtime }
        : null;
      const policyModel = gsdResolveModelPolicy(policyForRuntime, tier);
      if (policyModel) return { model: policyModel };
      return gsdResolveTierEntry({
        runtime,
        tier,
        overrides: merged.model_profile_overrides,
      });
    },
  };
}

/**
 * Resolve the effective model override for a single agent, given a
 * pre-resolved `modelOverrides` map and `runtimeResolver` (both from the
 * functions above). Pure — no filesystem access.
 *
 * Precedence (J8 — identical for kilo and opencode, resolved through this ONE
 * shared function so the two runtimes can never diverge):
 *   1. modelOverrides[agentName]         (#2256 — explicit per-agent override)
 *   2. runtimeResolver.resolve(agentName)?.model
 *      (#2794 — tier-based model_profile_overrides.<runtime>.<tier>)
 *   3. null (omit — J7: the frontmatter key must not appear, not `null`/`""`)
 */
function resolveAgentModelOverride(
  agentName: string,
  modelOverrides: Record<string, string> | null | undefined,
  runtimeResolver: RuntimeProfileResolver | null | undefined,
): string | null {
  const explicit = modelOverrides ? modelOverrides[agentName] : undefined;
  if (explicit) return explicit;
  if (runtimeResolver) {
    const entry = runtimeResolver.resolve(agentName);
    if (entry && entry.model) return entry.model;
  }
  return null;
}

export = {
  readGsdGlobalModelOverrides,
  readGsdEffectiveModelOverrides,
  readGsdEffectiveAgentTools,
  readGsdRuntimeProfileResolver,
  resolveAgentModelOverride,
};

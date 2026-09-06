/**
 * Model Resolver — Model and effort resolution policy
 *
 * ADR-857 rollout phase 2f: extracted from core.cts (issue #888).
 * Owns model and effort resolution policy: resolves the model, runtime tier,
 * planning granularity, reasoning effort, and fast-mode for a given agent by
 * reading project config and resolving against the model profiles and catalog.
 * Behaviour is preserved byte-for-behaviour from the prior location; only
 * the module boundary moved. The core.cjs re-export spine was retired in
 * epic #1267; callers import resolvers from model-resolver.cjs directly.
 *
 * Dependencies (leaf modules only):
 *   - node:fs / node:path (read the per-install .gsd-runtime marker + project config for the #2297 omit gate)
 *   - ./runtime-name-policy.cjs (resolveRuntimeNameFromCandidates — canonicalize the active runtime)
 *   - ./planning-workspace.cjs  (planningDir — workstream/project-aware project-config path)
 *   - ./config-loader.cjs    (loadConfig)
 *   - ./configuration.cjs    (CONFIG_DEFAULTS as CANONICAL_CONFIG_DEFAULTS)
 *   - ./model-profiles.cjs   (MODEL_PROFILES, AGENT_TO_PHASE_TYPE, AGENT_DEFAULT_TIERS, VALID_AGENT_TIERS, nextTier)
 *   - ./model-catalog.cjs    (MODEL_ALIAS_MAP, RUNTIME_PROFILE_MAP, PROVIDER_PRESETS, VALID_TIERS,
 *                             CLAUDE_AGENT_ALIASES — re-exported below for back-compat, #3241)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderModule = require('./config-loader.cjs');
const { loadConfig } = configLoaderModule;

// ─── Configuration Module (for CANONICAL_CONFIG_DEFAULTS used by effort/fast_mode resolvers) ─
import { CONFIG_DEFAULTS as CANONICAL_CONFIG_DEFAULTS } from './configuration.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelProfiles = require('./model-profiles.cjs');
const { MODEL_PROFILES, AGENT_TO_PHASE_TYPE, AGENT_DEFAULT_TIERS, VALID_AGENT_TIERS, nextTier } = modelProfiles;

import { MODEL_ALIAS_MAP, RUNTIME_PROFILE_MAP, PROVIDER_PRESETS, VALID_TIERS, CLAUDE_AGENT_ALIASES, mergeEffortTierDefaults } from './model-catalog.cjs';

import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimeNameFromCandidates } from './runtime-name-policy.cjs';
import {
  readInstallRuntimeMarker,
  _setInstallRuntimeMarkerForTests,
  _resetInstallRuntimeMarkerCacheForTests,
} from './runtime-slash.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;

// ─── #2297: per-install runtime identity for the resolve_model_ids:"omit" gate ─
//
// The installer writes `resolve_model_ids:"omit"` into the SHARED
// ~/.gsd/defaults.json for every runtime that lacks native model aliases (#1156).
// Because that file is machine-wide, a non-Claude install would otherwise poison
// a Claude no-project resolution into returning '' — silently defeating Claude's
// adaptive tier aliases. The "omit" must therefore apply only when a runtime that
// genuinely lacks native aliases is the one resolving.
//
// In a no-project session there is no `.planning/config.json` (so config.runtime
// is null) and GSD_RUNTIME is not exported by gsd-core, so the only reliable
// current-runtime signal is the per-install marker the installer co-locates next
// to VERSION at <install>/gsd-core/.gsd-runtime (this file's dir is
// <install>/gsd-core/bin/lib). Precedence for the gate: project config.runtime →
// GSD_RUNTIME env (manual/CI override + test seam) → install marker → 'claude'.
//
// `claude` is currently the ONLY runtime with nativeModelAliases:true; a
// registry-parity test guards this set so a future alias-capable runtime fails
// loudly here instead of silently omitting.
const RUNTIMES_WITH_NATIVE_ALIASES: ReadonlySet<string> = new Set(['claude']);

// #3897 rung 2: the marker reader + its cache and test seams were promoted to
// the canonical owner, `runtime-slash.cts` (imported above) — this module now
// consumes that single implementation instead of holding its own copy. N5:
// behaviour and the seam contract are unchanged by the move; the re-exports
// below (`export =` at the bottom of this file) preserve every existing
// caller's `require('./model-resolver.cjs')` surface byte-for-behaviour.

// The runtime whose install is actually resolving, canonicalized so an alias or
// case variant (e.g. "claude-code"/"Claude") cannot defeat the native-alias
// check below (#2297 review). Precedence mirrors resolveRuntime()
// (runtime-slash.cts): GSD_RUNTIME env → project config.runtime → per-install
// .gsd-runtime marker → 'claude'.
function resolveActiveRuntime(config: Record<string, unknown>): string {
  return resolveRuntimeNameFromCandidates(
    process.env['GSD_RUNTIME'],
    config['runtime'],
    readInstallRuntimeMarker(),
  ) || 'claude';
}

// Did the PROJECT's own config (root `.planning/config.json` or the active
// workstream/project override) explicitly set resolve_model_ids to "omit"?
// Project config takes precedence over the shared ~/.gsd/defaults.json (#2297
// out-of-scope guard + #2517 finding #4): an explicit project "omit" is honored
// regardless of runtime, whereas an "omit" that came only from the global
// defaults is ignored by native-alias runtimes. Workstream/project-scope aware
// via planningDir (mirrors loadConfig's precedence: workstream value wins over
// root); a plain read avoids loadConfig's normalization side effects.
function projectExplicitlySetsOmit(cwd: string): boolean {
  const wsDir = planningDir(cwd);
  const rootDir = path.join(cwd, '.planning');
  const layers = wsDir === rootDir ? [rootDir] : [wsDir, rootDir]; // workstream > root
  for (const dir of layers) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
      const value = parsed?.['resolve_model_ids'];
      // First layer that sets the key wins (matches loadConfig's deep-merge
      // precedence). A layer that omits the key falls through to the next.
      if (value !== undefined) return value === 'omit';
    } catch {
      // Absent/unreadable layer — try the next.
    }
  }
  return false;
}

// ─── Model alias resolution ───────────────────────────────────────────────────

interface TierEntryResolved {
  model: string;
  reasoning_effort?: string;
  [key: string]: unknown;
}

interface ResolveTierEntryOpts {
  runtime: string | null | undefined;
  tier: string | null | undefined;
  overrides: Record<string, unknown> | null | undefined;
}

/**
 * #2517 — Resolve the runtime-aware tier entry for (runtime, tier).
 */
function resolveTierEntry({ runtime, tier, overrides }: ResolveTierEntryOpts): TierEntryResolved | null {
  if (!runtime || !tier) return null;

  const runtimeMap = RUNTIME_PROFILE_MAP as unknown as Record<string, Record<string, Record<string, unknown>>>;
  const builtin = runtimeMap[runtime]?.[tier] || null;
  const overridesMap = overrides as Record<string, Record<string, unknown>> | null | undefined;
  const userRaw = overridesMap?.[runtime]?.[tier];

  let userEntry: Record<string, unknown> | null = null;
  if (userRaw) {
    userEntry = typeof userRaw === 'string' ? { model: userRaw } : (userRaw as Record<string, unknown>);
  }

  if (!builtin && !userEntry) return null;
  return { ...(builtin || {}), ...(userEntry || {}) } as TierEntryResolved;
}

/**
 * Convenience wrapper used by resolveModelInternal.
 */
function _resolveRuntimeTier(config: Record<string, unknown>, tier: string): TierEntryResolved | null {
  return resolveTierEntry({
    runtime: config['runtime'] as string | null | undefined,
    tier,
    overrides: config['model_profile_overrides'] as Record<string, unknown> | null | undefined,
  });
}

/**
 * #4192 — Resolve the claude-runtime TIER OVERRIDE model for (config, tier).
 *
 * Step 3's runtime-aware resolution deliberately skips the claude runtime to
 * preserve the alias-native posture (#1156/#2297): with no user override, the
 * resolver must keep returning bare tier aliases, and the builtin claude tier
 * map (`opus → claude-opus-4-8`, …) must never force full-ID emission on every
 * default install. But `model_profile_overrides.<runtime>.<tier>` is a
 * documented override point (docs/CONFIGURATION.md § Runtime-Aware Profiles)
 * that `workflows/settings-advanced.md` actively writes for claude-runtime
 * users — and #4192 Finding 1 measured the key inert on this runtime.
 *
 * This helper reads ONLY the user's override entry for the effective claude
 * runtime and tier — never the builtin claude tier map — so an install with no
 * override is byte-identical to before the fix. The runtime is resolved the
 * same way steps 1-3 resolve it (config['runtime'], defaulting to 'claude'),
 * NOT via resolveActiveRuntime (GSD_RUNTIME/marker): the value policy must
 * key off the config the operator wrote, matching mapClaudeOverrideForRuntime.
 *
 * Value policy mirrors the model_overrides path (#2041/#4192): an override
 * value that maps to a current tier alias collapses to that alias
 * (byte-equivalent resolution, alias-form emission); anything else — a pinned
 * older generation (`claude-opus-4-7`), a bare alias/tier repoint (`sonnet`),
 * or a non-Claude vendor id (`openai/o3`) — is emitted verbatim as pinned.
 * Malformed entries (no usable `model` string) return null so the caller falls
 * through to normal alias resolution (ADR-443 D1: invalid values fall through).
 */
function resolveClaudeTierOverrideModel(
  configRuntime: string | null | undefined,
  tier: string | null | undefined,
  overrides: Record<string, unknown> | null | undefined,
): string | null {
  if (!tier || tier === 'inherit') return null;
  const effectiveRuntime = configRuntime || 'claude';
  if (effectiveRuntime !== 'claude') return null; // non-claude runtimes resolve at step 3
  const overridesMap = overrides as Record<string, Record<string, unknown>> | null | undefined;
  if (!overridesMap || typeof overridesMap !== 'object') return null;
  // Own-property guards throughout: both levels are config-supplied plain
  // objects, so a prototype-chain key ("constructor", "toString") must not
  // resolve an inherited member instead of falling through (same hardening as
  // every other config-keyed lookup in this module).
  const runtimeEntry = Object.hasOwn(overridesMap, effectiveRuntime)
    ? overridesMap[effectiveRuntime]
    : undefined;
  if (!runtimeEntry || typeof runtimeEntry !== 'object') return null;
  const userRaw = Object.hasOwn(runtimeEntry, tier) ? runtimeEntry[tier] : undefined;
  if (userRaw === undefined || userRaw === null) return null;
  const entry: Record<string, unknown> = typeof userRaw === 'string'
    ? { model: userRaw }
    : (userRaw as Record<string, unknown>);
  if (!entry || typeof entry !== 'object') return null;
  const model = entry['model'];
  if (typeof model !== 'string' || model.length === 0) return null;
  if (Object.hasOwn(CLAUDE_POLICY_ID_TO_ALIAS, model)) {
    return CLAUDE_POLICY_ID_TO_ALIAS[model];
  }
  return model;
}

// Reverse of the Claude tier-default IDs, plus the Fable alias which Claude
// Code's Agent tool accepts but which is not a GSD model-profile tier (#1133).
const CLAUDE_POLICY_ID_TO_ALIAS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(MODEL_ALIAS_MAP)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .map(([aliasName, id]) => [id, aliasName]),
  ),
  'claude-fable-5': 'fable',
};
// CLAUDE_AGENT_ALIASES moved to ./model-catalog.cts (#3241) — imported above
// and re-exported below for back-compat (bin/install.js:474,
// tests/codex-config.test.cjs:24 depend on the name being on this module).

// Dedupe stderr warnings so repeated agent resolutions don't spam (#1133).
const _modelPolicyUnmappableWarned = new Set<string>();
function warnModelPolicyUnmappable(agentType: string, policyModel: string, tier: string): void {
  const key = `${agentType}::${policyModel}::${tier}`;
  if (_modelPolicyUnmappableWarned.has(key)) return;
  _modelPolicyUnmappableWarned.add(key);
  // MUST go to stderr — resolve-model's JSON result is parsed from stdout.
  process.stderr.write(
    `gsd: warning — model_policy resolved "${policyModel}" for ${agentType}, ` +
    `but it has no Claude agent alias; using "${tier}" instead.\n`,
  );
}

// Test-only: reset the model_policy warn-dedupe cache between cases (#1133).
function _resetModelPolicyWarningCacheForTests(): void {
  _modelPolicyUnmappableWarned.clear();
}

// Dedupe stderr warnings for unmappable model_overrides Claude IDs (#2041 /
// #4192). #2041 originally warned that such a value was being DROPPED to tier
// resolution; #4192 keeps the warn-once breadcrumb but changes the behavior to
// a verbatim pass-through, so the text now describes the pass-through.
const _modelOverrideUnmappableWarned = new Set<string>();
function warnModelOverrideUnmappable(agentType: string, overrideValue: string): void {
  const key = `${agentType}::${overrideValue}`;
  if (_modelOverrideUnmappableWarned.has(key)) return;
  _modelOverrideUnmappableWarned.add(key);
  // Cap emission length so an oversized or secret-shaped value cannot leak in
  // full to stderr/logs (#2041 security review). MUST go to stderr — resolve-
  // model's JSON result is parsed from stdout.
  const safe = overrideValue.length > 64 ? overrideValue.slice(0, 64) + '…' : overrideValue;
  process.stderr.write(
    `gsd: warning — model_overrides value "${safe}" for ${agentType} is a fully-qualified ` +
    `Claude model ID with no tier alias; passing it through verbatim. Claude Code setups ` +
    `whose Agent tool accepts only tier aliases will not honor it. (#4192)\n`,
  );
}

// Test-only: reset the model_overrides warn-dedupe cache between cases (#2041).
function _resetModelOverrideWarningCacheForTests(): void {
  _modelOverrideUnmappableWarned.clear();
}

/**
 * #2041 — Map a `model_overrides` value to its Claude Agent-tool alias on the
 * claude runtime, mirroring the `model_policy` path (#1144). Claude Code's
 * Agent tool `model` parameter documents tier aliases (opus/sonnet/haiku/
 * fable) as the always-accepted form. Returns the value to emit verbatim, or
 * null to signal "fall through to normal tier/dynamic-routing resolution".
 * Non-Claude runtimes and non-Claude values always pass through verbatim.
 *
 * #4192 — an unmappable `claude-*` value (a pinned generation that is not the
 * current catalog default, e.g. `claude-opus-4-7`) is now PASSED THROUGH
 * VERBATIM with a warn-once stderr breadcrumb, instead of being dropped to
 * tier resolution. #2041's drop was correct when the value was plausibly a
 * mis-typed current default, but for an explicit pin it silently UNPINNED the
 * operator's choice — the resolver would report a tier the config never asked
 * for, the exact "profile can misrepresent what actually runs" defect #4192
 * files. The documented contract ("any fully-qualified model ID",
 * docs/CONFIGURATION.md § Per-Agent Overrides,
 * gsd-core/references/model-profiles.md § Per-Agent Overrides) is restored:
 * the pin is resolved as configured. Values that DO map to a current tier
 * alias still collapse to that alias — byte-equivalent resolution, the #2041
 * protection preserved — and a mappable pin never warns.
 *
 * Hardening (code+security review): a `typeof` guard preserves the pre-fix
 * no-crash behavior if a malformed config surfaces a non-string value, and an
 * `Object.hasOwn` lookup defeats `__proto__`/`constructor` lookups on the plain
 * object literal so those reserved keys cannot return a truthy non-string.
 */
function mapClaudeOverrideForRuntime(
  override: string,
  configRuntime: string | null | undefined,
  agentType: string,
): string | null {
  // Defensive: model_overrides is typed Record<string,string> but a malformed
  // config could surface a non-string; pass through verbatim (preserving the
  // pre-fix no-crash behaviour) and let the downstream Agent tool reject it.
  if (typeof override !== 'string') return override;
  const onClaude = !configRuntime || configRuntime === 'claude';
  if (!onClaude) return override;
  // Object.hasOwn guards against __proto__/constructor returning a truthy
  // non-string from the plain object literal (#2041 security review).
  if (Object.hasOwn(CLAUDE_POLICY_ID_TO_ALIAS, override)) {
    return CLAUDE_POLICY_ID_TO_ALIAS[override];
  }
  if (CLAUDE_AGENT_ALIASES.has(override)) return override;
  if (override.startsWith('claude-')) {
    // #4192: explicit generation pin — resolve as configured (see docblock).
    warnModelOverrideUnmappable(agentType, override);
    return override;
  }
  return override;
}

/**
 * #49 — Provider-neutral model policy preset resolution.
 */
function resolveModelPolicy(policy: Record<string, unknown> | null | undefined, tier: string | null | undefined): string | null {
  if (!policy || typeof policy !== 'object') return null;
  if (!tier) return null;

  const runtime = policy['runtime'];
  const rtOverrides = policy['runtime_tiers'];
  if (runtime && typeof runtime === 'string' && rtOverrides && typeof rtOverrides === 'object') {
    const rtOverridesMap = rtOverrides as Record<string, unknown>;
    if (Object.hasOwn(rtOverridesMap, runtime)) {
      const runtimeEntry = rtOverridesMap[runtime];
      if (runtimeEntry && typeof runtimeEntry === 'object' && Object.hasOwn(runtimeEntry, tier)) {
        const raw = (runtimeEntry as Record<string, unknown>)[tier];
        if (raw != null) {
          const entry = typeof raw === 'string' ? { model: raw } : (raw as Record<string, unknown>);
          if (entry && entry['model']) return entry['model'] as string;
        }
      }
    }
  }

  const provider = policy['provider'];
  if (!provider || typeof provider !== 'string') return null;

  if (provider === 'generic' || provider === 'custom') {
    const TIER_TO_POLICY_KEY: Record<string, string> = { opus: 'high', sonnet: 'medium', haiku: 'low' };
    const policyKey = TIER_TO_POLICY_KEY[tier];
    if (!policyKey) return null;
    const v = policy[policyKey];
    return (v && typeof v === 'string') ? v : null;
  }

  const presetsMap = PROVIDER_PRESETS as Record<string, Record<string, Record<string, { model: string } | null>>>;
  if (!Object.hasOwn(presetsMap, provider)) return null;
  const presetForProvider = presetsMap[provider];
  if (!presetForProvider || typeof presetForProvider !== 'object') return null;

  if (!Object.hasOwn(presetForProvider, tier)) return null;
  const tierPresets = presetForProvider[tier];
  if (!tierPresets || typeof tierPresets !== 'object') return null;

  const budget = (policy['budget'] && typeof policy['budget'] === 'string') ? policy['budget'] : 'medium';
  if (!Object.hasOwn(tierPresets, budget)) return null;
  const budgetEntry = tierPresets[budget];
  if (!budgetEntry || !budgetEntry.model) return null;

  return budgetEntry.model;
}

/**
 * #2229 — the profile/phase-type tier for (config, agentType).
 *
 * Extracted verbatim from resolveModelInternal's step 2 so the same expression can
 * answer "which tier did GSD resolve?" without also resolving a model id. The
 * extraction is behaviour-preserving by construction: resolveModelInternal calls
 * straight back into it.
 *
 * Returns null when the agent has no catalog entry and the profile is not `inherit`.
 */
function computeProfileTier(config: Record<string, unknown>, agentType: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const profile = String(config['model_profile'] || 'balanced').toLowerCase();
  // Own-property guard: agentType is an unvalidated CLI positional (the
  // `resolve-model <agent-type>` argument is never checked against a known
  // agent list), so a prototype-chain agentType ("toString", "constructor")
  // would otherwise return an inherited member from this plain object
  // instead of undefined — verified reachable purely via the CLI.
  const modelProfilesMap = MODEL_PROFILES as unknown as Record<string, Record<string, string>>;
  const agentModels = Object.hasOwn(modelProfilesMap, agentType) ? modelProfilesMap[agentType] : undefined;
  const phaseType = (AGENT_TO_PHASE_TYPE)[agentType];
  const configModels = config['models'] as Record<string, string> | null | undefined;
  const phaseTypeTier = (phaseType && configModels && typeof configModels === 'object')
    ? configModels[phaseType]
    : undefined;
  return (phaseTypeTier && VALID_TIERS.has(phaseTypeTier))
    ? phaseTypeTier
    : (profile === 'inherit'
      ? 'inherit'
      : (agentModels
        // Own-property guard: `profile` is a config-supplied string
        // (config['model_profile'], lower-cased); an already-lowercase
        // prototype-chain key ("constructor", "__proto__") would otherwise
        // return an inherited non-string member instead of falling back to
        // 'balanced' (verified: profile:"constructor"/"__proto__" leaked a
        // function/object through both the tier and model resolution paths).
        ? ((Object.hasOwn(agentModels, profile) ? agentModels[profile] : undefined) || agentModels['balanced'])
        : null));
}

/**
 * #2229 — the effective model TIER for (config, agentType), as a signal a workflow can
 * read: `gsd_run query resolve-model <agent> --pick tier`.
 *
 * Why this is not just "look at the resolved model": on every runtime the installer
 * configures with `resolve_model_ids: "omit"` — which is every non-Claude runtime, see
 * docs/CONFIGURATION.md — resolveModelInternal deliberately returns '' below. A guard
 * keyed on the model id therefore cannot tell a budget-tier run from a top-tier one
 * there, while the tier itself is computed ABOVE that early-return and stays knowable.
 *
 * Honesty contract — this never guesses, because a guard that reports a wrong tier is
 * worse than one that reports none:
 *   - a per-agent `model_overrides` pin naming a known alias (or a full Claude id that
 *     maps to one) reports that alias;
 *   - a pin that maps to nothing reports 'unknown' — a raw model id carries no tier;
 *   - `model_profile: inherit` reports 'inherit' — the session model is not ours to name;
 *   - an agent with no catalog entry reports 'unknown'.
 *
 * Callers must treat 'unknown' and 'inherit' as "cannot tell", never as "adequate".
 */
function resolveTierFromConfig(config: Record<string, unknown>, agentType: string): string {
  const rawOverrides = config['model_overrides'];
  const modelOverrides = (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides))
    ? rawOverrides as Record<string, string>
    : null;
  // Own-property guard: agentType is a caller-supplied string (the
  // `resolve-model <agent-type>` CLI positional is not validated against a
  // known agent list); a prototype-chain agentType ("toString",
  // "constructor") against ANY model_overrides object — even `{}` — would
  // otherwise return an inherited member instead of undefined.
  const override = (modelOverrides && Object.hasOwn(modelOverrides, agentType))
    ? modelOverrides[agentType]
    : undefined;
  if (override && typeof override === 'string') {
    if (CLAUDE_AGENT_ALIASES.has(override)) return override;
    // Own-property guard: this indexes a plain object with a config-supplied
    // string, so a prototype-chain key ("toString", "constructor", "valueOf")
    // would otherwise return an inherited member instead of undefined — and a
    // function-valued tier is dropped entirely by JSON.stringify, silently
    // removing the key a guard depends on.
    const alias = Object.hasOwn(CLAUDE_POLICY_ID_TO_ALIAS, override)
      ? CLAUDE_POLICY_ID_TO_ALIAS[override]
      : undefined;
    if (typeof alias === 'string' && alias) return alias;
    return 'unknown';
  }

  const profileTier = computeProfileTier(config, agentType);

  // #3282 — mirror resolveModelInternal's step 2.5 (model_policy preset). The
  // profile tier alone under-reports: model_policy can dispatch a DIFFERENT
  // tier than the profile implies (e.g. a `balanced` profile's "sonnet" tier
  // combined with `model_policy: {budget: 'low'}` actually spawns "haiku"),
  // and reporting the profile tier there is exactly the under-report this
  // fixes — a haiku-tier run must never be reported as "sonnet". Skipped
  // under the same condition resolveModelInternal skips it (no tier, or
  // "inherit" — the session model is not ours to name).
  if (profileTier && profileTier !== 'inherit') {
    const mergedPolicy = config['model_policy']
      ? { ...(config['model_policy'] as Record<string, unknown>), runtime: (config['runtime'] as string | null | undefined) || 'claude' }
      : null;
    const policyModel = resolveModelPolicy(mergedPolicy, profileTier);
    if (policyModel) {
      // Map the policy-resolved id back to a tier alias with the same
      // own-property-guarded lookups used above. If it maps, that alias IS
      // the tier that actually runs — report it (the fix). If it does not
      // map — including every non-Claude runtime, where resolveModelInternal
      // returns the policy model verbatim with no tier meaning — the model
      // carries no tier we can name; report 'unknown' rather than falling
      // back to the profile tier, which would silently reintroduce the
      // under-report this block exists to close.
      const aliasForId = Object.hasOwn(CLAUDE_POLICY_ID_TO_ALIAS, policyModel)
        ? CLAUDE_POLICY_ID_TO_ALIAS[policyModel]
        : undefined;
      if (typeof aliasForId === 'string' && aliasForId) return aliasForId;
      if (CLAUDE_AGENT_ALIASES.has(policyModel)) return policyModel;
      return 'unknown';
    }
  }

  return profileTier || 'unknown';
}

function resolveTierInternal(cwd: string, agentType: string): string {
  return resolveTierFromConfig(loadConfig(cwd), agentType);
}

function resolveModelInternal(cwd: string, agentType: string): string {
  const config = loadConfig(cwd);

  // 1. Per-agent override (#2041: map Claude full IDs → Agent-tool aliases on
  // the claude runtime, mirroring the model_policy path #1144; non-Claude
  // runtimes and non-Claude values pass through verbatim).
  const modelOverrides = config['model_overrides'] as Record<string, string> | null | undefined;
  // Own-property guard (see resolveTierFromConfig above): without it, an
  // agentType of "toString" against `model_overrides: {}` returned the
  // inherited Function.prototype.toString as the resolved "model" — verified
  // reachable purely via the CLI, no override value needed.
  const override = (modelOverrides && Object.hasOwn(modelOverrides, agentType))
    ? modelOverrides[agentType]
    : undefined;
  if (override) {
    const mapped = mapClaudeOverrideForRuntime(override, config['runtime'] as string | null | undefined, agentType);
    if (mapped !== null) return mapped;
    // Unmappable Claude ID — fall through to tier resolution (matches model_policy).
  }

  // 2. Compute the tier (#2229: shared with resolveTierFromConfig so the tier a
  // workflow reads and the tier a model is resolved from can never diverge).
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const profile = String(config['model_profile'] || 'balanced').toLowerCase();
  // Own-property guard (see computeProfileTier above): without it, agentType
  // "toString" returned Function.prototype.toString as `agentModels`
  // (truthy), which skipped the "unknown agent" fallback below and made
  // resolveModelInternal return undefined instead of a tier-derived string.
  const modelProfilesMapForModel = MODEL_PROFILES as unknown as Record<string, Record<string, string>>;
  const agentModels = Object.hasOwn(modelProfilesMapForModel, agentType) ? modelProfilesMapForModel[agentType] : undefined;
  const tier = computeProfileTier(config, agentType);

  // 2.5. model_policy preset (#49, #1133)
  const configRuntime = config['runtime'] as string | null | undefined;
  if (tier && tier !== 'inherit') {
    const onClaude = !configRuntime || configRuntime === 'claude';
    const effectiveRuntime = configRuntime || 'claude';
    const mergedPolicy = config['model_policy']
      ? { ...(config['model_policy'] as Record<string, unknown>), runtime: effectiveRuntime }
      : null;
    const policyModel = resolveModelPolicy(mergedPolicy, tier);
    if (policyModel) {
      // Non-Claude runtimes take full model IDs verbatim (unchanged behavior).
      if (!onClaude) return policyModel;
      // Claude Code's Agent tool takes tier aliases (opus/sonnet/haiku/fable),
      // not full model IDs — map the policy-resolved ID back to an alias (#1133).
      const aliasForId = Object.hasOwn(CLAUDE_POLICY_ID_TO_ALIAS, policyModel)
        ? CLAUDE_POLICY_ID_TO_ALIAS[policyModel]
        : undefined;
      if (typeof aliasForId === 'string' && aliasForId) return aliasForId;
      // The policy value may already be a bare Claude agent alias (e.g. "fable").
      if (CLAUDE_AGENT_ALIASES.has(policyModel)) return policyModel;
      // No Claude alias for this ID (e.g. a pinned minor version like
      // claude-opus-4-5). Warn once and fall through to the tier alias rather
      // than returning an ID Claude Code cannot spawn.
      warnModelPolicyUnmappable(agentType, policyModel, tier);
    }
  }

  // 3. Runtime-aware resolution (#2517)
  if (configRuntime && configRuntime !== 'claude' && tier && tier !== 'inherit') {
    const entry = _resolveRuntimeTier(config, tier);
    if (entry?.model) return entry.model;
  }

  // 4. resolve_model_ids: "omit" — runtime-aware (#2297). Honor "omit" when the
  // PROJECT explicitly set it (user intent — project config wins, #2517 finding
  // #4) OR when the active runtime genuinely lacks native model aliases. Only a
  // native-alias runtime (Claude) ignores an "omit" that came solely from the
  // SHARED ~/.gsd/defaults.json — the #2297 poisoning fix — and falls through to
  // its tier aliases below. Active runtime: GSD_RUNTIME → config.runtime → the
  // per-install .gsd-runtime marker → 'claude' (canonicalized).
  // NOTE: a non-Claude runtime that HAS a populated runtime-tier map already
  // returned its own model id at step 3 above, before this gate — for those the
  // explicit-project-omit honoring here is moot (step 3 wins, by #2517 design).
  if (config['resolve_model_ids'] === 'omit'
      && (projectExplicitlySetsOmit(cwd) || !RUNTIMES_WITH_NATIVE_ALIASES.has(resolveActiveRuntime(config)))) {
    return '';
  }

  // 4.5. Claude-runtime tier override (#4192 Finding 1). Sits AFTER the omit
  // gate so an explicit project `resolve_model_ids:"omit"` still wins (#2297:
  // explicit project omit is honored regardless of runtime), and BEFORE the
  // alias return so a pinned generation is not re-collapsed to a tier alias or
  // re-materialized to the LATEST catalog id by step 5's
  // `resolve_model_ids:true` path. Fires ONLY when the user wrote a
  // `model_profile_overrides.claude.<tier>` entry for this tier — see
  // resolveClaudeTierOverrideModel for why the builtin map stays out.
  if (tier && tier !== 'inherit') {
    const claudeOverrideModel = resolveClaudeTierOverrideModel(
      configRuntime,
      tier,
      config['model_profile_overrides'] as Record<string, unknown> | null | undefined,
    );
    if (claudeOverrideModel !== null) return claudeOverrideModel;
  }

  // 5. Profile lookup (Claude-native default).
  if (!agentModels) {
    return profile === 'quality' ? 'opus'
      : profile === 'budget' ? 'haiku'
      : profile === 'inherit' ? 'inherit'
      : 'sonnet';
  }
  if (tier === 'inherit') return 'inherit';
  const alias = tier;

  // Only the explicit `true` opt-in materializes full model IDs (#1569). Guard
  // against the loose-truthy check catching a "omit" that a native-alias runtime
  // ignored above (#2297): "omit" must fall through to the tier ALIAS here, not
  // be materialized into a full ID Claude's Agent tool cannot spawn.
  if (config['resolve_model_ids'] === true) {
    return (MODEL_ALIAS_MAP as Record<string, string>)[alias!] || alias!;
  }

  return alias!;
}

const VALID_GRANULARITIES = new Set(['coarse', 'standard', 'fine']);

/**
 * Resolve the planning granularity for a phase type (#68).
 */
function resolveGranularityInternal(cwd: string, phaseType: string | null | undefined, override?: string | null): string {
  if (override !== undefined && override !== null && override !== '') {
    if (VALID_GRANULARITIES.has(override)) {
      return override;
    }
  }
  const config = loadConfig(cwd);
  const configGranularities = config['granularities'] as Record<string, string> | null | undefined;
  const perPhase = (phaseType && configGranularities && typeof configGranularities === 'object')
    ? configGranularities[phaseType]
    : undefined;
  if (perPhase && VALID_GRANULARITIES.has(perPhase)) {
    return perPhase;
  }
  if (config['granularity'] !== undefined && config['granularity'] !== null && config['granularity'] !== '') {
    return config['granularity'] as string;
  }
  const planning = config['planning'] as Record<string, unknown> | null | undefined;
  const planningGran = planning && planning['granularity'];
  if (planningGran !== undefined && planningGran !== null && planningGran !== '') {
    return planningGran as string;
  }
  return 'standard';
}

/**
 * Validate a CLI granularity override at the command boundary. Empty/null/undefined
 * are treated as "no override" (no-op). An invalid non-empty value calls `fail`.
 */
function assertValidGranularityOverride(
  override: string | null | undefined,
  fail: (msg: string) => never,
): void {
  if (override !== undefined && override !== null && override !== '' && !VALID_GRANULARITIES.has(override)) {
    fail(`invalid granularity '${override}' (valid: ${[...VALID_GRANULARITIES].join(', ')})`);
  }
}

/**
 * #3024 — Resolve a model for a specific dynamic-routing attempt.
 */
function resolveModelForTier(cwd: string, agentType: string, attempt?: number): string {
  const config = loadConfig(cwd);
  const attemptN = Number.isInteger(attempt) && (attempt as number) > 0 ? (attempt as number) : 0;

  const modelOverrides = config['model_overrides'] as Record<string, string> | null | undefined;
  // Own-property guard (see resolveTierFromConfig above): without it, an
  // agentType of "toString" against `model_overrides: {}` returned the
  // inherited Function.prototype.toString as the resolved "model" — verified
  // reachable purely via the CLI, no override value needed.
  const override = (modelOverrides && Object.hasOwn(modelOverrides, agentType))
    ? modelOverrides[agentType]
    : undefined;
  if (override) {
    const mapped = mapClaudeOverrideForRuntime(override, config['runtime'] as string | null | undefined, agentType);
    if (mapped !== null) return mapped;
    // Unmappable Claude ID — fall through to dynamic_routing / model_policy resolution.
  }

  if (config['model_policy'] && config['runtime'] && config['runtime'] !== 'claude') {
    return resolveModelInternal(cwd, agentType);
  }

  const dr = config['dynamic_routing'] as Record<string, unknown> | null | undefined;
  if (!dr || typeof dr !== 'object' || dr['enabled'] !== true) {
    return resolveModelInternal(cwd, agentType);
  }

  const tierModels = dr['tier_models'] as Record<string, string> | null | undefined;
  if (!tierModels || typeof tierModels !== 'object') {
    return resolveModelInternal(cwd, agentType);
  }

  const defaultTier = (AGENT_DEFAULT_TIERS)[agentType];
  if (!defaultTier || !(VALID_AGENT_TIERS).has(defaultTier)) {
    return resolveModelInternal(cwd, agentType);
  }

  const maxEscalations = Number.isInteger(dr['max_escalations']) && (dr['max_escalations'] as number) >= 0
    ? (dr['max_escalations'] as number)
    : 1;
  const escalationEnabled = dr['escalate_on_failure'] !== false;
  const effectiveAttempt = escalationEnabled
    ? Math.min(attemptN, maxEscalations)
    : 0;

  let tier = defaultTier;
  for (let i = 0; i < effectiveAttempt; i += 1) {
    const next = (nextTier)(tier);
    if (!next || next === tier) break;
    tier = next;
  }

  const alias = tierModels[tier];
  if (typeof alias !== 'string' || alias.length === 0) {
    return resolveModelInternal(cwd, agentType);
  }
  return alias;
}

/**
 * #2296 — Outcome of consulting the provider-escalation ladder for one attempt.
 *
 * `from`/`to` describe the PROVIDER ladder only; they are equal whenever the
 * ladder was not consulted or had nothing to offer.
 */
interface ProviderEscalationResult {
  from: string;
  to: string;
  escalated: boolean;
  exhausted: boolean;
  attempted: string[];
  index: number;
}

/**
 * Keep only usable model ids: non-empty strings. A malformed config can put
 * anything in here (nulls, numbers, blank strings), and a blank model id would
 * resolve to an unusable agent invocation rather than failing visibly. Invalid
 * entries are dropped and the surviving order is preserved, so the ladder stays
 * predictable (ADR 227 — validate shape, not just type).
 */
function sanitizeProviderEscalation(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

/**
 * #2296 — Resolve the model for one attempt of the PROVIDER escalation ladder.
 *
 * The tier ladder (`resolveModelForTier`) escalates within one provider's
 * `tier_models`, which does not help when that provider is the thing that is
 * throttled. This walks `dynamic_routing.provider_escalation` instead: an
 * ordered list of alternative model ids, capped by
 * `min(max_escalations, list length)`.
 *
 * `applicable` is the caller's policy decision (only a quota-exceeded
 * classification should consult this ladder). It is a parameter rather than a
 * class check here so this module keeps depending only on leaf modules, per
 * CONTEXT.md's Model Resolution module contract.
 *
 * Attempt 0 — and every non-applicable call — stays on the source model.
 * `exhausted` reports that the ladder is spent so the caller can fail loudly
 * naming every model it tried.
 */
function resolveProviderEscalation(
  cwd: string,
  agentType: string,
  attempt: number | undefined,
  applicable: boolean,
): ProviderEscalationResult {
  // The model that would be used with no provider escalation at all.
  const from = resolveModelForTier(cwd, agentType, 0);
  const stay = (exhausted = false): ProviderEscalationResult => ({
    from,
    to: from,
    escalated: false,
    exhausted,
    attempted: [from],
    index: 0,
  });

  if (!applicable) return stay();

  const config = loadConfig(cwd);
  const dr = config['dynamic_routing'] as Record<string, unknown> | null | undefined;
  if (!dr || typeof dr !== 'object' || dr['enabled'] !== true) return stay();
  if (dr['escalate_on_failure'] === false) return stay();

  const list = sanitizeProviderEscalation(dr['provider_escalation']);
  if (list.length === 0) return stay();

  // Same default and same validity rule as the tier ladder above — a negative or
  // non-integer max_escalations is invalid config, not a request for zero.
  const maxEscalations = Number.isInteger(dr['max_escalations']) && (dr['max_escalations'] as number) >= 0
    ? (dr['max_escalations'] as number)
    : 1;
  const cap = Math.min(maxEscalations, list.length);
  // An explicit cap of 0 means the ladder exists but is spent before it starts.
  if (cap === 0) return stay(true);

  const attemptN = Number.isInteger(attempt) && (attempt as number) > 0 ? (attempt as number) : 0;
  if (attemptN === 0) return stay();

  const index = Math.min(attemptN, cap);
  return {
    from,
    to: list[index - 1],
    escalated: true,
    exhausted: attemptN > cap,
    attempted: [from, ...list.slice(0, index)],
    index,
  };
}

// ─── #443 — Unified effort + fast_mode resolvers ─────────────────────────────

const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// #3533 (10d): the VOCABULARY carries one more member than the LADDER —
// 'inherit' is a declarable effort choice ("follow the session", expressed by
// OMITTING the effort key at the writer) but not a level nextEffort may step
// into. Keeping it out of VALID_EFFORTS means escalation (resolveEffortForTier)
// never walks past an explicit inherit: nextEffort('inherit') is null.
const EFFORT_SET = new Set([...VALID_EFFORTS, 'inherit']);

/**
 * Walk one step up the effort ladder from `e`.
 */
function nextEffort(e: string): string | null {
  const i = VALID_EFFORTS.indexOf(e);
  if (i < 0) return null;
  return VALID_EFFORTS[Math.min(i + 1, VALID_EFFORTS.length - 1)];
}

interface EffortOpts {
  override?: string;
}

interface FastModeOpts {
  override?: boolean;
}

/**
 * #443 — Resolve a universal effort string for (cwd, agentType).
 */
function resolveEffortInternal(cwd: string, agentType: string, opts?: EffortOpts): string {
  // Step 1: invocation override
  if (opts && typeof opts.override === 'string' && EFFORT_SET.has(opts.override)) {
    return opts.override;
  }

  const config = loadConfig(cwd);
  const effortCfg = (config['effort'] && typeof config['effort'] === 'object' && !Array.isArray(config['effort']))
    ? (config['effort'] as Record<string, unknown>)
    : null;

  // Step 2: agent_overrides
  if (effortCfg) {
    const ao = effortCfg['agent_overrides'];
    if (ao && typeof ao === 'object' && !Array.isArray(ao)) {
      const v = (ao as Record<string, unknown>)[agentType];
      if (typeof v === 'string' && EFFORT_SET.has(v)) return v;
    }
  } else {
    const canonicalEffort = (CANONICAL_CONFIG_DEFAULTS)['effort'];
    const mao = canonicalEffort && typeof canonicalEffort === 'object'
      ? (canonicalEffort as Record<string, unknown>)['agent_overrides']
      : undefined;
    if (mao && typeof mao === 'object' && !Array.isArray(mao)) {
      const v = (mao as Record<string, unknown>)[agentType];
      if (typeof v === 'string' && EFFORT_SET.has(v)) return v;
    }
  }

  // Step 3: routing_tier_defaults by agent's default tier.
  // #3531 (10c): the config block merges OVER the manifest tier defaults
  // rather than replacing them — an effort block without
  // routing_tier_defaults (or missing this agent's tier) falls back to the
  // manifest built-in for that tier instead of skipping to effort.default.
  // Invalid config values are dropped by the merge, so the manifest value for
  // the tier surfaces (the same "invalid falls through" rule every layer has).
  const agentTier = (AGENT_DEFAULT_TIERS)[agentType];
  if (agentTier) {
    const canonicalEffort = (CANONICAL_CONFIG_DEFAULTS)['effort'];
    const manifestDefaults = canonicalEffort && typeof canonicalEffort === 'object'
      ? (canonicalEffort as Record<string, unknown>)['routing_tier_defaults'] as Record<string, string> | undefined
      : undefined;
    const isValidEffort = (v: unknown): v is string => typeof v === 'string' && EFFORT_SET.has(v);
    const merged = mergeEffortTierDefaults(
      manifestDefaults,
      effortCfg ? effortCfg['routing_tier_defaults'] : undefined,
      isValidEffort,
    );
    const v = merged[agentTier];
    if (isValidEffort(v)) return v;
  }

  // Step 4: effort.default
  if (effortCfg) {
    const d = effortCfg['default'];
    if (typeof d === 'string' && EFFORT_SET.has(d)) return d;
  } else {
    const canonicalEffort = (CANONICAL_CONFIG_DEFAULTS)['effort'];
    const d = canonicalEffort && typeof canonicalEffort === 'object'
      ? (canonicalEffort as Record<string, unknown>)['default']
      : undefined;
    if (typeof d === 'string' && EFFORT_SET.has(d)) return d;
  }

  // Step 5: hardcoded default
  return 'high';
}

/**
 * #443 — Resolve fast_mode boolean for (cwd, agentType).
 */
function resolveFastModeInternal(cwd: string, agentType: string, opts?: FastModeOpts): boolean {
  // Step 1: invocation override
  if (opts && typeof opts.override === 'boolean') {
    return opts.override;
  }

  const config = loadConfig(cwd);
  const fmCfg = (config['fast_mode'] && typeof config['fast_mode'] === 'object' && !Array.isArray(config['fast_mode']))
    ? (config['fast_mode'] as Record<string, unknown>)
    : null;

  // Step 2: agent_overrides
  if (fmCfg) {
    const ao = fmCfg['agent_overrides'];
    if (ao && typeof ao === 'object' && !Array.isArray(ao)) {
      const v = (ao as Record<string, unknown>)[agentType];
      if (typeof v === 'boolean') return v;
    }
  }

  // Step 3: routing_tier_defaults by agent's default tier.
  const agentTier = (AGENT_DEFAULT_TIERS)[agentType];
  if (agentTier) {
    if (fmCfg && fmCfg['routing_tier_defaults'] &&
        typeof fmCfg['routing_tier_defaults'] === 'object' &&
        !Array.isArray(fmCfg['routing_tier_defaults'])) {
      const v = (fmCfg['routing_tier_defaults'] as Record<string, unknown>)[agentTier];
      if (typeof v === 'boolean') return v;
    } else if (!fmCfg) {
      const canonicalFm = (CANONICAL_CONFIG_DEFAULTS)['fast_mode'];
      const manifestDefaults = canonicalFm && typeof canonicalFm === 'object'
        ? (canonicalFm as Record<string, unknown>)['routing_tier_defaults']
        : undefined;
      if (manifestDefaults && typeof manifestDefaults === 'object') {
        const v = (manifestDefaults as Record<string, unknown>)[agentTier];
        if (typeof v === 'boolean') return v;
      }
    }
  }

  // Step 4: fast_mode.enabled
  if (fmCfg && typeof fmCfg['enabled'] === 'boolean') {
    return fmCfg['enabled'];
  }

  // Step 5: hardcoded default
  return false;
}

/**
 * #443 — Resolve effort for a dynamic-routing attempt (with escalation).
 */
function resolveEffortForTier(cwd: string, agentType: string, attempt?: number): string {
  const base = resolveEffortInternal(cwd, agentType);

  const config = loadConfig(cwd);
  const dr = config['dynamic_routing'] as Record<string, unknown> | null | undefined;
  if (!dr || typeof dr !== 'object' || dr['enabled'] !== true) {
    return base;
  }
  if (dr['escalate_on_failure'] === false) {
    return base;
  }

  const maxEscalations = Number.isInteger(dr['max_escalations']) && (dr['max_escalations'] as number) >= 0
    ? (dr['max_escalations'] as number)
    : 1;

  const attemptN = Number.isInteger(attempt) && (attempt as number) > 0 ? (attempt as number) : 0;
  const effectiveAttempt = Math.min(attemptN, maxEscalations);

  let current = base;
  for (let i = 0; i < effectiveAttempt; i++) {
    const next = nextEffort(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

export = {
  resolveTierEntry,
  CLAUDE_AGENT_ALIASES,
  resolveModelPolicy,
  resolveModelInternal,
  resolveTierInternal,
  resolveTierFromConfig,
  _resetModelPolicyWarningCacheForTests,
  _resetModelOverrideWarningCacheForTests,
  _setInstallRuntimeMarkerForTests,
  _resetInstallRuntimeMarkerCacheForTests,
  VALID_GRANULARITIES,
  resolveGranularityInternal,
  assertValidGranularityOverride,
  resolveModelForTier,
  resolveProviderEscalation,
  VALID_EFFORTS,
  EFFORT_SET,
  nextEffort,
  resolveEffortInternal,
  resolveFastModeInternal,
  resolveEffortForTier,
};

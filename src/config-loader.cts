/**
 * Config Loader — Project configuration loading
 *
 * ADR-857 rollout phase 2e: extracted from core.cts (issue #885).
 * Owns project configuration loading: reads `.planning/config.json`,
 * merges built-in defaults (`CONFIG_DEFAULTS`/`CANONICAL_CONFIG_DEFAULTS`),
 * normalizes legacy keys, applies the active-workstream overlay, validates
 * against the config schema, and warns on unknown keys/profile overrides.
 * Behaviour is preserved byte-for-behaviour from the prior location; only
 * the module boundary moved. The core.cjs re-export spine was retired in
 * epic #1267; callers import loadConfig from config-loader.cjs directly.
 *
 * Dependencies (leaf modules only):
 *   - node:fs / node:os / node:path (stdlib)
 *   - ./configuration.cjs    (normalizeLegacyKeys, CONFIG_DEFAULTS as CANONICAL_CONFIG_DEFAULTS)
 *   - ./config-schema.cjs    (VALID_CONFIG_KEYS, DYNAMIC_KEY_PATTERNS)
 *   - ./planning-workspace.cjs (planningDir, planningRoot)
 *   - ./shell-command-projection.cjs (execGit, platformWriteSync, platformReadSync)
 *   - ./core-utils.cjs       (detectSubRepos)
 *   - ./model-catalog.cjs    (KNOWN_RUNTIMES, KNOWN_PROVIDERS, ADAPTIVE_TIER_VALUES)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execGit, platformWriteSync, platformReadSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, planningRoot } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsModule = require('./core-utils.cjs');
const { detectSubRepos } = coreUtilsModule;
// ─── Configuration Module (generated CJS mirror) ────────────────────────────
import { CONFIG_DEFAULTS as CANONICAL_CONFIG_DEFAULTS, normalizeLegacyKeys } from './configuration.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configSchema = require('./config-schema.cjs');
const { VALID_CONFIG_KEYS, DYNAMIC_KEY_PATTERNS, isCentralConfigKey: _isCentralConfigKeyFn } = configSchema;
import { KNOWN_RUNTIMES, KNOWN_PROVIDERS, ADAPTIVE_TIER_VALUES } from './model-catalog.cjs';
// ─── Federated Config (ADR-857 phase 3b) ─────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
import federatedConfigModule = require('./federated-config.cjs');
const { mergeFederatedConfig } = federatedConfigModule;
// The capability-registry.cjs is generated and lives in the same gsd-core/bin/lib/ output dir.
// Both config-loader.cjs and capability-registry.cjs land in gsd-core/bin/lib/ at build time.
// This is the FROZEN first-party registry — used as the test-seam default and the
// fallback. Overlay (installed third-party) config-key federation is cwd-dependent
// and composed PER loadConfig CALL by _federatedConfigSchema(cwd) below (ADR-1244 D2),
// never eagerly at module load.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const _capabilityRegistryReal: { configSchema?: Record<string, unknown> } = require('./capability-registry.cjs');

// Module-level registry reference. Defaults to the real generated registry.
// Overridable for tests via _setFederatedRegistryForTests.
let _capabilityRegistry: { configSchema?: Record<string, unknown> } = _capabilityRegistryReal;

/** Test-only seam: inject a synthetic registry. Call _resetFederatedRegistryForTests() to restore. */
function _setFederatedRegistryForTests(reg: { configSchema?: Record<string, unknown> }): void {
  _capabilityRegistry = reg;
}

/** Test-only seam: restore the real generated registry. */
function _resetFederatedRegistryForTests(): void {
  _capabilityRegistry = _capabilityRegistryReal;
}

// ─── File & Config utilities ──────────────────────────────────────────────────

/**
 * Canonical config defaults — flat-key projection for CJS consumers.
 *
 * Cycle 4: Values are sourced from CANONICAL_CONFIG_DEFAULTS (the nested
 * manifest loaded by configuration.generated.cjs). The flat shape is
 * preserved here so legacy consumers (config.cjs, verify.cjs, tests that
 * regex-parse this source) continue to work without changes. The key names
 * and the `const CONFIG_DEFAULTS = {` pattern are intentionally kept.
 *
 * Mapping notes:
 *  - workflow.plan_check  → plan_checker (CJS flat name; verify.cjs uses this)
 *  - git.*               → flat git keys (branching_strategy, templates)
 *  - workflow.*          → flat names (research, verifier, …)
 *  - planning.sub_repos  → sub_repos
 *  - planning.commit_docs / search_gitignored → top-level flat keys
 */

// CANONICAL_CONFIG_DEFAULTS is typed as Record<string, unknown> from configuration.cjs;
// we use a typed accessor to avoid repeated casts.
function _getConfigDefault(key: string): unknown {
  return (CANONICAL_CONFIG_DEFAULTS)[key];
}
function _getNestedConfigDefault(section: string, field: string): unknown {
  const sec = (CANONICAL_CONFIG_DEFAULTS)[section];
  if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
    return (sec as Record<string, unknown>)[field];
  }
  return undefined;
}

const CONFIG_DEFAULTS = {
  model_profile: _getConfigDefault('model_profile'),
  commit_docs: _getConfigDefault('commit_docs'),
  search_gitignored: _getConfigDefault('search_gitignored'),
  branching_strategy: _getNestedConfigDefault('git', 'branching_strategy'),
  phase_branch_template: _getNestedConfigDefault('git', 'phase_branch_template'),
  milestone_branch_template: _getNestedConfigDefault('git', 'milestone_branch_template'),
  quick_branch_template: _getNestedConfigDefault('git', 'quick_branch_template'),
  research: _getNestedConfigDefault('workflow', 'research'),
  plan_checker: _getNestedConfigDefault('workflow', 'plan_check'), // flat CJS name maps to workflow.plan_check
  verifier: _getNestedConfigDefault('workflow', 'verifier'),
  nyquist_validation: _getNestedConfigDefault('workflow', 'nyquist_validation'),
  ai_integration_phase: _getNestedConfigDefault('workflow', 'ai_integration_phase'),
  api_coverage_gate: _getNestedConfigDefault('workflow', 'api_coverage_gate'),
  parallelization: _getConfigDefault('parallelization'),
  brave_search: _getConfigDefault('brave_search'),
  firecrawl: _getConfigDefault('firecrawl'),
  exa_search: _getConfigDefault('exa_search'),
  text_mode: _getNestedConfigDefault('workflow', 'text_mode'),
  sub_repos: _getNestedConfigDefault('planning', 'sub_repos'),
  resolve_model_ids: _getConfigDefault('resolve_model_ids'),
  context_window: _getConfigDefault('context_window'),
  phase_naming: _getConfigDefault('phase_naming'),
  project_code: _getConfigDefault('project_code'),
  subagent_timeout: _getNestedConfigDefault('workflow', 'subagent_timeout'),
  security_enforcement: _getNestedConfigDefault('workflow', 'security_enforcement'),
  security_asvs_level: _getNestedConfigDefault('workflow', 'security_asvs_level'),
  security_block_on: _getNestedConfigDefault('workflow', 'security_block_on'),
  post_planning_gaps: _getNestedConfigDefault('workflow', 'post_planning_gaps'),
  smart_zone_tokens: _getNestedConfigDefault('workflow', 'smart_zone_tokens'),
};

/**
 * Deep-merge two plain config objects. `overlay` wins on key conflict.
 * Explicit `null` in overlay overrides base (null means "unset this key").
 * Arrays are replaced, not merged. Non-object primitives use overlay value.
 *
 * Note: `undefined` in overlay is treated as "no value provided" and falls
 * back to base (preserves inheritance). Explicit `null` overrides base.
 */
function _deepMergeConfig(base: Record<string, unknown>, overlay: Record<string, unknown> | null | undefined): Record<string, unknown> | null | undefined {
  if (overlay === null || overlay === undefined) return overlay;
  if (typeof base !== 'object' || typeof overlay !== 'object') return overlay;
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overlay)) {
    // Prototype-pollution guard — mirrors the four sibling guards in this file
    // (lines ~315/319/331/341/549). Without it a workstream/root config.json with
    // {"__proto__": {...}} pollutes this merged object's prototype chain and can
    // spoof unset config flags. (Per-object pollution, not global Object.prototype.)
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (overlay[key] !== null && typeof overlay[key] === 'object' && !Array.isArray(overlay[key])) {
      result[key] = _deepMergeConfig((base[key] ?? {}) as Record<string, unknown>, overlay[key] as Record<string, unknown>);
    } else {
      result[key] = overlay[key];
    }
  }
  return result;
}

// Module-level deduplication for unknown-key warnings (#3523).
// A single `init phase-op N` call invokes loadConfig more than once; this Set
// prevents the same warning from being echoed on each invocation.
const _warnedUnknownConfigKeys = new Set<string>();

// Normalization result shape from configuration.cjs
interface NormalizationEntry {
  requiresFilesystem?: boolean;
  [key: string]: unknown;
}

// Typed parsed config shape used internally
interface ParsedConfig {
  [key: string]: unknown;
  planning?: Record<string, unknown>;
}

// ─── Git utilities ────────────────────────────────────────────────────────────

const _gitIgnoredCache = new Map<string, boolean>();

function isGitIgnored(cwd: string, targetPath: string): boolean {
  // #2206: strip trailing slashes — `git check-ignore` has a quirk where a
  // CRLF .gitignore with blank lines falsely reports a trailing-slash path
  // (e.g. `.planning/`) as ignored. Normalizing here protects every call site.
  const normalized = targetPath.replace(/\/+$/, '');
  const key = cwd + '::' + normalized;
  if (_gitIgnoredCache.has(key)) return _gitIgnoredCache.get(key)!;
  // --no-index checks .gitignore rules regardless of whether the file is tracked.
  const result = execGit(['check-ignore', '-q', '--no-index', '--', normalized], { cwd });
  const ignored = result.exitCode === 0;
  _gitIgnoredCache.set(key, ignored);
  return ignored;
}

// ─── Model alias resolution ───────────────────────────────────────────────────

// Catalog-derived (model-catalog.cts) so this vocabulary can never drift from
// VALID_TIERS in verify.cts — see #2070 "Generative Fix Divergence". Excludes
// 'inherit' (unlike VALID_TIERS): runtime overrides always resolve to a
// concrete tier, never the adaptive sentinel.
const RUNTIME_OVERRIDE_TIERS = ADAPTIVE_TIER_VALUES;
const _warnedConfigKeys = new Set<string>();

function _warnUnknownProfileOverrides(parsed: Record<string, unknown>, configLabel: string): void {
  if (!parsed || typeof parsed !== 'object') return;

  const runtime = parsed['runtime'];
  if (runtime && typeof runtime === 'string' && !(KNOWN_RUNTIMES).has(runtime)) {
    const key = `${configLabel}::runtime::${runtime}`;
    if (!_warnedConfigKeys.has(key)) {
      _warnedConfigKeys.add(key);
      try {
        process.stderr.write(
          `gsd: warning — config key "runtime" has unknown value "${runtime}". ` +
          `Known runtimes: ${[...(KNOWN_RUNTIMES)].sort().join(', ')}. ` +
          `Resolution will fall back to safe defaults. (#2517)\n`
        );
      } catch { /* stderr might be closed in some test harnesses */ }
    }
  }

  const overrides = parsed['model_profile_overrides'];
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [overrideRuntime, tierMap] of Object.entries(overrides as Record<string, unknown>)) {
      if (!(KNOWN_RUNTIMES).has(overrideRuntime)) {
        const key = `${configLabel}::override-runtime::${overrideRuntime}`;
        if (!_warnedConfigKeys.has(key)) {
          _warnedConfigKeys.add(key);
          try {
            process.stderr.write(
              `gsd: warning — model_profile_overrides.${overrideRuntime}.* uses ` +
              `unknown runtime "${overrideRuntime}". Known runtimes: ` +
              `${[...(KNOWN_RUNTIMES)].sort().join(', ')}. (#2517)\n`
            );
          } catch { /* ok */ }
        }
      }
      if (!tierMap || typeof tierMap !== 'object') continue;
      for (const tierName of Object.keys(tierMap)) {
        if (!RUNTIME_OVERRIDE_TIERS.has(tierName)) {
          const key = `${configLabel}::override-tier::${overrideRuntime}.${tierName}`;
          if (!_warnedConfigKeys.has(key)) {
            _warnedConfigKeys.add(key);
            try {
              process.stderr.write(
                `gsd: warning — model_profile_overrides.${overrideRuntime}.${tierName} ` +
                `uses unknown tier "${tierName}". Allowed tiers: opus, sonnet, haiku. (#2517)\n`
              );
            } catch { /* ok */ }
          }
        }
      }
    }
  }

  const policy = parsed['model_policy'];
  if (policy && typeof policy === 'object' && !Array.isArray(policy)) {
    const policyObj = policy as Record<string, unknown>;
    const provider = policyObj['provider'];
    const _POLICY_SENTINEL_PROVIDERS = new Set(['generic', 'custom']);
    if (provider && typeof provider === 'string' &&
        !(KNOWN_PROVIDERS).has(provider) && !_POLICY_SENTINEL_PROVIDERS.has(provider)) {
      const pkey = `${configLabel}::model_policy::provider::${provider}`;
      if (!_warnedConfigKeys.has(pkey)) {
        _warnedConfigKeys.add(pkey);
        try {
          process.stderr.write(
            `gsd: warning — model_policy.provider has unknown value "${provider}". ` +
            `Known providers: ${[...(KNOWN_PROVIDERS)].sort().join(', ')}. ` +
            `For manual model IDs use provider="custom". (#49)\n`
          );
        } catch { /* ok */ }
      }
    }

    const rtOverrides = policyObj['runtime_tiers'];
    if (rtOverrides && typeof rtOverrides === 'object' && !Array.isArray(rtOverrides)) {
      for (const [pruntime, tierMap] of Object.entries(rtOverrides as Record<string, unknown>)) {
        if (!(KNOWN_RUNTIMES).has(pruntime)) {
          const key = `${configLabel}::model_policy.runtime_tiers::${pruntime}`;
          if (!_warnedConfigKeys.has(key)) {
            _warnedConfigKeys.add(key);
            try {
              process.stderr.write(
                `gsd: warning — model_policy.runtime_tiers.${pruntime}.* uses ` +
                `unknown runtime "${pruntime}". Known runtimes: ` +
                `${[...(KNOWN_RUNTIMES)].sort().join(', ')}. (#49)\n`
              );
            } catch { /* ok */ }
          }
        }
        if (!tierMap || typeof tierMap !== 'object') continue;
        for (const tierName of Object.keys(tierMap)) {
          if (!RUNTIME_OVERRIDE_TIERS.has(tierName)) {
            const key = `${configLabel}::model_policy.runtime_tiers::${pruntime}.${tierName}`;
            if (!_warnedConfigKeys.has(key)) {
              _warnedConfigKeys.add(key);
              try {
                process.stderr.write(
                  `gsd: warning — model_policy.runtime_tiers.${pruntime}.${tierName} ` +
                  `uses unknown tier "${tierName}". Allowed: opus, sonnet, haiku. (#49)\n`
                );
              } catch { /* ok */ }
            }
          }
        }
      }
    }
  }
}

// Internal helper exposed for tests so per-process warning state can be reset
// between cases that intentionally exercise the warning path repeatedly.
// Clears BOTH dedup sets: _warnedConfigKeys (runtime/model-policy/tier warnings)
// and _warnedUnknownConfigKeys (unknown top-level keys). Omitting the latter made
// this a silent no-op for the suite that exists to test it — the leaked state
// suppressed any later case reusing a key, and the existing cases only passed
// because each picked a key name no other case reused (#2674).
function _resetRuntimeWarningCacheForTests(): void {
  _warnedConfigKeys.clear();
  _warnedUnknownConfigKeys.clear();
  _warnedUnusableConfig.clear();
}

// ─── FIX 2: Federated overlay helpers ────────────────────────────────────────

/**
 * Apply federated key values into a mutable config object.
 * Handles N-level dotted keys (e.g. "a.b.c" → obj.a.b.c).
 * Only adds keys that are not already present (does not clobber).
 * Inline prototype-pollution guards at every segment.
 */
function _applyFederatedValues(
  obj: Record<string, unknown>,
  values: Record<string, unknown>,
  validKeys: string[],
): void {
  for (const dottedKey of validKeys) {
    // S2: inline literal guard on full key
    if (dottedKey === '__proto__' || dottedKey === 'constructor' || dottedKey === 'prototype') continue;
    const parts = dottedKey.split('.');
    if (parts.length === 1) {
      const topKey = parts[0];
      if (topKey !== '__proto__' && topKey !== 'constructor' && topKey !== 'prototype') {
        if (!Object.prototype.hasOwnProperty.call(obj, topKey)) {
          obj[topKey] = values[dottedKey];
        }
      }
    } else {
      // N-level nested key: traverse/create intermediate objects
      let cur: Record<string, unknown> = obj;
      let ok = true;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        // S2: inline literal guard on each segment
        if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') { ok = false; break; }
        if (!Object.prototype.hasOwnProperty.call(cur, seg) || cur[seg] === null) {
          cur[seg] = {};
        }
        if (typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) { ok = false; break; }
        cur = cur[seg] as Record<string, unknown>;
      }
      if (!ok) continue;
      const leafKey = parts[parts.length - 1];
      // S2: inline literal guard on leaf
      if (leafKey === '__proto__' || leafKey === 'constructor' || leafKey === 'prototype') continue;
      if (!Object.prototype.hasOwnProperty.call(cur, leafKey)) {
        cur[leafKey] = values[dottedKey];
      }
    }
  }
}

/**
 * FIX 2: Apply the federated overlay to a base config object.
 * When validKeys is empty (current registry — all keys are central),
 * returns the baseConfig UNCHANGED (true no-op, preserves reference identity).
 * When validKeys is non-empty, applies values into a shallow clone to avoid
 * mutating shared CONFIG_DEFAULTS/module constants.
 */
// Resolve the federated capability config-schema for a project (ADR-1244 D2).
// A test override (via _setFederatedRegistryForTests) wins; otherwise, when a
// project cwd is available, compose the installed overlay for THAT project —
// LAZILY (never at module load, so a bare require never scans the filesystem and
// the result is never cached for the wrong cwd) — falling back to the frozen
// first-party schema when there is no cwd or the loader is unavailable.
function _federatedConfigSchema(cwd?: string): Record<string, unknown> | undefined {
  if (_capabilityRegistry !== _capabilityRegistryReal) {
    return _capabilityRegistry.configSchema; // explicit test override
  }
  if (typeof cwd === 'string' && cwd) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const loaderMod: { loadRegistry: (o?: Record<string, unknown>) => { configSchema?: Record<string, unknown> } } = require('./capability-loader.cjs');
      // #1459 IC-04: thread the consent home explicitly so a consented project cap's federated config
      // key resolves at the SAME user-owned home that gated its activation (never the wrong home).
      const schema = loaderMod.loadRegistry({ includeInstalled: true, cwd, gsdHome: process.env['GSD_HOME'] }).configSchema;
      if (schema && typeof schema === 'object') return schema;
    } catch { /* fall back to first-party */ }
  }
  return _capabilityRegistryReal.configSchema;
}

function _applyFederatedOverlay(
  baseConfig: Record<string, unknown>,
  userConfig: Record<string, unknown>,
  cwd?: string,
): Record<string, unknown> {
  const _fedRegistrySchema = _federatedConfigSchema(cwd);
  if (!_fedRegistrySchema || typeof _fedRegistrySchema !== 'object') return baseConfig;
  const _fedOverlay = mergeFederatedConfig({
    configSchema: _fedRegistrySchema,
    isCentralKey: (key: string) => _isCentralConfigKeyFn(key),
    userConfig,
  });
  // True no-op: if no federated keys, return UNCHANGED (byte-identical, no clone)
  if (_fedOverlay.validKeys.length === 0) return baseConfig;
  // Clone shallowly to avoid mutating shared constants, then apply nested values
  const cloned: Record<string, unknown> = { ...baseConfig };
  _applyFederatedValues(cloned, _fedOverlay.values, _fedOverlay.validKeys);
  return cloned;
}

// ─── Resolution Provenance (ADR-1411, #1415) ─────────────────────────────────

/** Source of a resolved config: which layer actually supplied the config. */
type ConfigSource = 'workstream' | 'root' | 'builtin-defaults' | 'global-defaults';

/**
 * Result of loadConfigResolved — wraps the config object with provenance metadata.
 * - source: which layer supplied the config
 * - degraded: true when the resolution did not deliver the configuration it
 *             should have — either a workstream was requested but its
 *             config.json was absent (fell back to root), or a file on the
 *             resolution path exists but is unusable (#1880). `reason` says which.
 */
/**
 * Machine-readable outcome of a config resolution (#1880, ADR-1411 amendment
 * "corrupt is not absent"). `Resolution<T>`'s four documented values all
 * describe a resolution *miss*; the two `config_un*` values below are the
 * unusable-input class that amendment introduced, and they are what makes a
 * corrupt file distinguishable from an absent one.
 *
 * Frozen enum rather than bare strings so tests assert on the typed surface
 * instead of diagnostic prose (CONTRIBUTING.md — Prohibited: Raw Text Matching
 * on Test Outputs).
 */
const CONFIG_REASON = Object.freeze({
  /** A config file was found, parsed, and supplied at least one setting. */
  RESOLVED: 'resolved',
  /** No config file exists at the resolved path. Genuine absence — NOT degraded. */
  NOT_CONFIGURED: 'not_configured',
  /** A config file exists and parsed, but carried no settings (`{}`). */
  CONFIGURED_EMPTY: 'configured_empty',
  /** A workstream was requested but had no config; fell back to root. */
  WORKSTREAM_FALLBACK: 'workstream_fallback',
  /** The file exists but is not valid JSON — settings were NOT applied. */
  CONFIG_UNPARSEABLE: 'config_unparseable',
  /** The file exists but could not be read (EACCES/EIO/…) — NOT applied. */
  CONFIG_UNREADABLE: 'config_unreadable',
} as const);

type ConfigReason = (typeof CONFIG_REASON)[keyof typeof CONFIG_REASON];

/** A config file that exists but cannot be used. Absence is NOT a fault. */
interface ConfigFault {
  reason: typeof CONFIG_REASON.CONFIG_UNPARSEABLE | typeof CONFIG_REASON.CONFIG_UNREADABLE;
  /** Resolved path of the offending file — half of the diagnostic dedup key. */
  path: string;
  /** errno for an unreadable file; '' for a parse failure. The other half. */
  code: string;
}

interface ConfigResolution {
  config: Record<string, unknown>;
  source: ConfigSource;
  degraded: boolean;
  /**
   * Why this resolution produced what it did. `degraded` alone cannot separate
   * "no config here" from "your config is corrupt and was discarded" — both
   * previously returned identical objects (#1880).
   */
  reason: ConfigReason;
}

/**
 * Read + JSON-parse a config file, keeping *absent* distinguishable from
 * *unusable*. `platformReadSync` returns null on ENOENT and re-throws every
 * other errno, which is the seam that makes this separable at all.
 */
function _readConfigFile(filePath: string):
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'absent' }
  | { kind: 'fault'; fault: ConfigFault } {
  let raw: string | null;
  try {
    raw = platformReadSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    return { kind: 'fault', fault: { reason: CONFIG_REASON.CONFIG_UNREADABLE, path: filePath, code } };
  }
  if (raw === null) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'fault', fault: { reason: CONFIG_REASON.CONFIG_UNPARSEABLE, path: filePath, code: '' } };
  }
  // Shape, not just parseability (ADR-227). `0`, `"x"`, `[]` and `null` are all
  // valid JSON but are not a config object. Accepting them let a PRESENT file
  // parse "ok", then throw downstream, and be reported not_configured by the
  // outer catch — a corrupt file indistinguishable from an absent one, which is
  // the exact defect this change closes. Caught by the fast-check property.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'fault', fault: { reason: CONFIG_REASON.CONFIG_UNPARSEABLE, path: filePath, code: '' } };
  }
  return { kind: 'ok', data: parsed as Record<string, unknown> };
}

/**
 * Dedup set for the unusable-config diagnostic. Keyed on resolved path + errno
 * per the ADR-1411 amendment — never on message text, which would couple the
 * guard to wording, and never on the errno alone, which would suppress a
 * genuine second failure in a different file.
 */
const _warnedUnusableConfig = new Set<string>();

/**
 * The wiring clause (ADR-1411 amendment). `reason` lives on `ConfigResolution`,
 * but `loadConfig` — the wrapper roughly fifty call sites use — returns
 * `.config` alone and would never surface it. Without this diagnostic the field
 * is unreachable to almost every consumer, and the user whose config was
 * silently discarded still gets no signal. That was the whole defect in #1880.
 */
function _warnUnusableConfig(fault: ConfigFault): void {
  const key = `${fault.path} ${fault.reason} ${fault.code}`;
  if (_warnedUnusableConfig.has(key)) return;
  _warnedUnusableConfig.add(key);
  const what = fault.reason === CONFIG_REASON.CONFIG_UNPARSEABLE
    ? 'is not valid JSON'
    : `could not be read (${fault.code})`;
  process.stderr.write(
    `gsd-tools: warning: ${fault.path} ${what} — its settings were NOT applied; using defaults instead\n`,
  );
}

/**
 * loadConfigResolved — provenance-aware config loading (#1415, ADR-1411 P2).
 *
 * Identical to loadConfig in every observable way except it returns
 * { config, source, degraded } instead of just the config object.
 * loadConfig now delegates to this function (byte-identical back-compat).
 *
 * Branch → source/degraded/reason mapping:
 *   A1: ws set + ws config.json found → source:'workstream', degraded:false, reason:'resolved'|'configured_empty'
 *   A2: ws null + config.json found   → source:'root',       degraded:false, reason:'resolved'|'configured_empty'
 *   B:  catch + .planning/ + rootParsed set (ws fallback) → source:'root', degraded:true, reason:'workstream_fallback'
 *   C:  catch + .planning/ + rootParsed null (federated defaults) → source:'builtin-defaults', degraded:false, reason:'not_configured'
 *   D:  catch + no .planning/ + ~/.gsd/defaults.json readable → source:'global-defaults', degraded:false, reason:'not_configured'
 *   E:  catch + no .planning/ + no global → source:'builtin-defaults', degraded:false, reason:'not_configured'
 *
 * ORTHOGONAL to all of the above (#1880, ADR-1411 "corrupt is not absent"): if
 * any config file on the resolution path exists but is UNUSABLE — invalid JSON,
 * or an errno such as EACCES — every branch instead returns degraded:true with
 * reason:'config_unparseable'|'config_unreadable', and a deduplicated stderr
 * diagnostic names the file. Before this, a trailing comma in config.json was
 * byte-identical to the file not existing: builtin defaults, degraded:false,
 * and the user's entire configuration silently discarded.
 */
function loadConfigResolved(cwd: string, options: Record<string, unknown> = {}): ConfigResolution {
  // NOTE: loadConfigResolved resolves from cwd AS-IS (no walk-up).
  // Callers that need ancestor-anchoring (e.g. cmdAgentSkills) must do so
  // themselves via findProjectRoot() before calling this function.
  // This preserves back-compat for the ~30 other loadConfig callers (#1415).

  const activeWorkstream = Object.prototype.hasOwnProperty.call(options, 'workstream')
    ? options['workstream']
    : (options['workstreamContext'] && Object.prototype.hasOwnProperty.call(options['workstreamContext'], 'ws'))
      ? (options['workstreamContext'] as Record<string, unknown>)['ws']
    : (process.env['GSD_WORKSTREAM'] || null);
  const ws = typeof activeWorkstream === 'string' ? activeWorkstream : (activeWorkstream === null ? null : null);
  // wsRequested: true when caller explicitly requested a non-empty workstream.
  // Used for source labeling (Fix 4) and early absent-dir intercept (Fix 2).
  const wsRequested = ws != null && ws !== '';

  let cachedSubRepos: string[] | undefined;
  const getDetectedSubRepos = (): string[] => {
    if (cachedSubRepos === undefined) cachedSubRepos = detectSubRepos(cwd);
    return cachedSubRepos.slice();
  };
  // Faults are captured, not thrown: the existing control flow (one broad catch
  // that falls back to defaults) is preserved exactly — see #1880. All that is
  // added is knowing WHY the fallback fired, which is the whole defect.
  let configFault: ConfigFault | null = null;

  /**
   * Stamp a fallback return with its reason. Every branch below reaches defaults
   * (or the root config) — what differs is WHY, and before #1880 that was
   * unrecoverable: a corrupt file and an absent one produced identical objects.
   *
   * An unusable file always wins and always sets `degraded:true`; genuine
   * absence keeps whatever `degraded` the branch already decided, so the
   * existing #1366 workstream-fallback semantics are untouched.
   */
  const fallback = (r: Omit<ConfigResolution, 'reason'>): ConfigResolution => {
    if (configFault) return { ...r, degraded: true, reason: configFault.reason };
    return {
      ...r,
      reason: r.degraded ? CONFIG_REASON.WORKSTREAM_FALLBACK : CONFIG_REASON.NOT_CONFIGURED,
    };
  };

  let rootParsed: ParsedConfig | null = null;
  if (ws) {
    const rootConfigPath = path.join(planningRoot(cwd), 'config.json');
    try {
      const rootRead = _readConfigFile(rootConfigPath);
      if (rootRead.kind === 'fault') {
        configFault = rootRead.fault;
        _warnUnusableConfig(rootRead.fault);
      }
      if (rootRead.kind !== 'ok') throw new Error('root config absent or unusable');
      rootParsed = rootRead.data;
      const { parsed: rootNormalized, normalizations: rootNorms } = normalizeLegacyKeys(rootParsed);
      if (rootNorms.length > 0) {
        for (const norm of rootNorms as unknown as NormalizationEntry[]) {
          if (norm.requiresFilesystem && !(rootNormalized as ParsedConfig).planning?.['sub_repos']) {
            const detected = getDetectedSubRepos();
            if (detected.length > 0) {
              if (!(rootNormalized as ParsedConfig).planning) (rootNormalized as ParsedConfig).planning = {};
              (rootNormalized as ParsedConfig).planning!['sub_repos'] = detected;
              (rootNormalized as ParsedConfig).planning!['commit_docs'] = false;
            }
          }
        }
        rootParsed = rootNormalized;
        try { platformWriteSync(rootConfigPath, JSON.stringify(rootParsed, null, 2)); } catch { /* ignore */ }
      } else {
        rootParsed = rootNormalized;
      }
    } catch {
      // Root config missing or unparseable — workstream config stands alone
    }
  }

  const configPath = path.join(planningDir(cwd, ws), 'config.json');
  const defaults = CONFIG_DEFAULTS;

  try {
    const read = _readConfigFile(configPath);
    if (read.kind === 'fault') {
      // The workstream/root config that ACTUALLY governs this resolution is
      // unusable. This outranks any earlier root-config fault for reporting.
      configFault = read.fault;
      _warnUnusableConfig(read.fault);
    }
    if (read.kind !== 'ok') throw new Error('config absent or unusable');
    const fileData: ParsedConfig = read.data;
    // Snapshot BEFORE normalizeLegacyKeys mutates fileData in place.
    const fileHadKeys = Object.keys(read.data).length > 0;

    let configDirty = false;
    {
      const { parsed: normalized, normalizations } = normalizeLegacyKeys(fileData);
      if (normalizations.length > 0) {
        Object.keys(fileData).forEach(k => delete (fileData as Record<string, unknown>)[k]);
        Object.assign(fileData, normalized);
        configDirty = true;
        for (const norm of normalizations as unknown as NormalizationEntry[]) {
          if (norm.requiresFilesystem && !fileData.planning?.['sub_repos']) {
            const detected = getDetectedSubRepos();
            if (detected.length > 0) {
              if (!fileData.planning) fileData.planning = {};
              fileData.planning['sub_repos'] = detected;
              fileData.planning['commit_docs'] = false;
            }
          }
        }
      }
    }

    const currentSubRepos = (fileData.planning?.['sub_repos'] as string[] | undefined) || [];
    if (Array.isArray(currentSubRepos) && currentSubRepos.length > 0) {
      const detected = getDetectedSubRepos();
      if (detected.length > 0) {
        const sorted = [...currentSubRepos].sort();
        if (JSON.stringify(sorted) !== JSON.stringify(detected)) {
          if (!fileData.planning) fileData.planning = {};
          fileData.planning['sub_repos'] = detected;
          configDirty = true;
        }
      }
    }

    if (configDirty) {
      try { platformWriteSync(configPath, JSON.stringify(fileData, null, 2)); } catch { /* ignore */ }
    }

    const parsed: ParsedConfig = rootParsed
      ? (_deepMergeConfig(rootParsed, fileData) as ParsedConfig ?? fileData)
      : fileData;

    const KNOWN_TOP_LEVEL = new Set([
      ...[...VALID_CONFIG_KEYS].map((k: string) => k.split('.')[0]),
      ...(DYNAMIC_KEY_PATTERNS as unknown as Array<{ topLevel: string }>).map(p => p.topLevel),
      'model_overrides', 'context_window', 'resolve_model_ids', 'claude_md_path', 'effort', 'fast_mode',
      'depth', 'multiRepo', 'branching_strategy', 'research',
    ]);

    let _preWarningFedValidKeys: string[] = [];
    try {
      const _fedRegistrySchemaEarly = _federatedConfigSchema(cwd);
      if (_fedRegistrySchemaEarly && typeof _fedRegistrySchemaEarly === 'object') {
        const _earlyOverlay = mergeFederatedConfig({
          configSchema: _fedRegistrySchemaEarly,
          isCentralKey: (key: string) => _isCentralConfigKeyFn(key),
          userConfig: parsed,
        });
        _preWarningFedValidKeys = _earlyOverlay.validKeys;
        for (const dottedKey of _preWarningFedValidKeys) {
          const topKey = dottedKey.split('.')[0];
          if (topKey !== '__proto__' && topKey !== 'constructor' && topKey !== 'prototype') {
            KNOWN_TOP_LEVEL.add(topKey);
          }
        }
      }
    } catch {
      // Defensive
    }

    const unknownKeys = Object.keys(parsed).filter(k => !KNOWN_TOP_LEVEL.has(k));
    if (unknownKeys.length > 0) {
      const warnKey = unknownKeys.join(',');
      if (!_warnedUnknownConfigKeys.has(warnKey)) {
        _warnedUnknownConfigKeys.add(warnKey);
        process.stderr.write(
          `gsd-tools: warning: unknown config key(s) in .planning/config.json: ${unknownKeys.join(', ')} — these will be ignored\n`
        );
      }
    }

    _warnUnknownProfileOverrides(parsed, '.planning/config.json');

    const get = (key: string, nested?: { section: string; field: string }): unknown => {
      if (parsed[key] !== undefined) return parsed[key];
      if (nested && parsed[nested.section] && typeof parsed[nested.section] === 'object' && parsed[nested.section] !== null) {
        const sec = parsed[nested.section] as Record<string, unknown>;
        if (sec[nested.field] !== undefined) {
          return sec[nested.field];
        }
      }
      return undefined;
    };

    const parallelization = (() => {
      const val = get('parallelization');
      if (typeof val === 'boolean') return val;
      if (typeof val === 'object' && val !== null && 'enabled' in (val)) return (val as Record<string, unknown>)['enabled'];
      return defaults.parallelization;
    })();

    const _baseConfig: Record<string, unknown> = {
      model_profile: get('model_profile') ?? defaults.model_profile,
      commit_docs: (() => {
        const explicit = get('commit_docs', { section: 'planning', field: 'commit_docs' });
        if (explicit !== undefined) return explicit;
        if (isGitIgnored(cwd, '.planning/')) return false;
        return defaults.commit_docs;
      })(),
      search_gitignored: get('search_gitignored', { section: 'planning', field: 'search_gitignored' }) ?? defaults.search_gitignored,
      branching_strategy: get('branching_strategy', { section: 'git', field: 'branching_strategy' }) ?? defaults.branching_strategy,
      phase_branch_template: get('phase_branch_template', { section: 'git', field: 'phase_branch_template' }) ?? defaults.phase_branch_template,
      milestone_branch_template: get('milestone_branch_template', { section: 'git', field: 'milestone_branch_template' }) ?? defaults.milestone_branch_template,
      quick_branch_template: get('quick_branch_template', { section: 'git', field: 'quick_branch_template' }) ?? defaults.quick_branch_template,
      research: get('research', { section: 'workflow', field: 'research' }) ?? defaults.research,
      plan_checker: get('plan_checker', { section: 'workflow', field: 'plan_check' }) ?? defaults.plan_checker,
      verifier: get('verifier', { section: 'workflow', field: 'verifier' }) ?? defaults.verifier,
      nyquist_validation: get('nyquist_validation', { section: 'workflow', field: 'nyquist_validation' }) ?? defaults.nyquist_validation,
      post_planning_gaps: get('post_planning_gaps', { section: 'workflow', field: 'post_planning_gaps' }) ?? defaults.post_planning_gaps,
      parallelization,
      brave_search: get('brave_search') ?? defaults.brave_search,
      firecrawl: get('firecrawl') ?? defaults.firecrawl,
      exa_search: get('exa_search') ?? defaults.exa_search,
      mvp_mode: get('mvp_mode', { section: 'workflow', field: 'mvp_mode' }) ?? false,
      text_mode: get('text_mode', { section: 'workflow', field: 'text_mode' }) ?? defaults.text_mode,
      auto_advance: get('auto_advance', { section: 'workflow', field: 'auto_advance' }) ?? false,
      _auto_chain_active: get('_auto_chain_active', { section: 'workflow', field: '_auto_chain_active' }) ?? false,
      mode: get('mode') ?? 'interactive',
      sub_repos: get('sub_repos', { section: 'planning', field: 'sub_repos' }) ?? defaults.sub_repos,
      resolve_model_ids: get('resolve_model_ids') ?? defaults.resolve_model_ids,
      context_window: get('context_window') ?? defaults.context_window,
      phase_naming: get('phase_naming') ?? defaults.phase_naming,
      project_code: get('project_code') ?? defaults.project_code,
      subagent_timeout: get('subagent_timeout', { section: 'workflow', field: 'subagent_timeout' }) ?? defaults.subagent_timeout,
      model_overrides: (parsed['model_overrides']) || null,
      models: (parsed['models']) || null,
      granularity: parsed['granularity'] !== undefined ? parsed['granularity'] : null,
      granularities: (parsed['granularities']) || null,
      planning: (parsed['planning']) || null,
      dynamic_routing: (parsed['dynamic_routing']) || null,
      runtime: (parsed['runtime']) || null,
      model_profile_overrides: (parsed['model_profile_overrides']) || null,
      model_policy: (parsed['model_policy']) || null,
      effort: (parsed['effort']) || null,
      fast_mode: (parsed['fast_mode']) || null,
      agent_skills: (parsed['agent_skills']) || {},
      agent_skills_security: (parsed['agent_skills_security']) || null,
      manager: (parsed['manager']) || {},
      response_language: get('response_language') || null,
      claude_md_path: get('claude_md_path') || null,
      claude_md_assembly: (parsed['claude_md_assembly']) || null,
    };

    // ADR-857 phase 3b: federated config overlay
    try {
      if (_preWarningFedValidKeys.length > 0) {
        const _fedRegistrySchema = _federatedConfigSchema(cwd);
        if (_fedRegistrySchema && typeof _fedRegistrySchema === 'object') {
          const _fedOverlay = mergeFederatedConfig({
            configSchema: _fedRegistrySchema,
            isCentralKey: (key: string) => _isCentralConfigKeyFn(key),
            userConfig: parsed,
          });
          _applyFederatedValues(_baseConfig, _fedOverlay.values, _fedOverlay.validKeys);
        }
      }
    } catch {
      // Defensive: keep no-throw contract
    }

    // A1 vs A2: disambiguate by whether a real workstream was requested.
    // Fix 4: empty-string ws ('') resolves the root path → source:'root'.
    const source: ConfigSource = wsRequested ? 'workstream' : 'root';

    // This config parsed — but a DIFFERENT file on the resolution path may not
    // have. A workstream config that loads cleanly while the root config it
    // inherits from is corrupt is still a degraded resolution: the root's
    // settings were silently dropped. Reporting `resolved` here would reopen
    // the exact hole this change closes, for the common case of a project that
    // uses workstreams at all.
    if (configFault) {
      return { config: _baseConfig, source, degraded: true, reason: configFault.reason };
    }

    // Emptiness is judged on the FILE THAT WAS READ, not on `parsed` (the
    // root+workstream merge). An empty workstream file inheriting a non-empty
    // root would otherwise report `resolved` while carrying no settings of its
    // own — the opposite of the not-configured/configured-empty distinction
    // ADR-1411 rule 3 requires.
    const reason = fileHadKeys
      ? CONFIG_REASON.RESOLVED
      : CONFIG_REASON.CONFIGURED_EMPTY;
    return { config: _baseConfig, source, degraded: false, reason };

  } catch {
    // Fix 2: Early intercept — workstream requested but ws config.json absent (or dir absent)
    // AND root config was loaded. Covers BOTH "dir exists, no config.json" AND "dir absent".
    // This delivers the #1366 acceptance criterion: nonexistent GSD_WORKSTREAM yields root, degraded.
    if (wsRequested && rootParsed) {
      const fb = loadConfigResolved(cwd, { workstream: null });
      return fallback({ config: fb.config, source: 'root', degraded: true });
    }

    // Branch B, C, D, E
    if (fs.existsSync(planningDir(cwd, ws))) {
      if (rootParsed) {
        // Branch B: workstream requested but ws config.json absent; root config present.
        // (Only reached when wsRequested is false — e.g. ws='' with .planning/workstreams//config.json)
        const fb = loadConfigResolved(cwd, { workstream: null });
        return fallback({ config: fb.config, source: 'root', degraded: true });
      }
      // Branch C: .planning/ exists but no config.json and no root config — federated/builtin defaults
      try {
        return fallback({ config: _applyFederatedOverlay(defaults, {}, cwd), source: 'builtin-defaults', degraded: false });
      } catch {
        return fallback({ config: defaults, source: 'builtin-defaults', degraded: false });
      }
    }
    // Branch D or E: no .planning/
    try {
      const home = process.env['GSD_HOME'] || os.homedir();
      const globalDefaultsPath = path.join(home, '.gsd', 'defaults.json');
      const globalRead = _readConfigFile(globalDefaultsPath);
      if (globalRead.kind === 'fault') {
        // ~/.gsd/defaults.json is present but unusable. Only report it when the
        // project config did not already fail — the nearer file is the one the
        // user is most likely to be able to act on.
        if (!configFault) configFault = globalRead.fault;
        _warnUnusableConfig(globalRead.fault);
      }
      if (globalRead.kind !== 'ok') throw new Error('global defaults absent or unusable');
      const globalDefaults = globalRead.data;
      const _globalBaseCfg: Record<string, unknown> = {
        ...defaults,
        model_profile: (globalDefaults['model_profile']) ?? defaults.model_profile,
        commit_docs: (globalDefaults['commit_docs']) ?? defaults.commit_docs,
        research: (globalDefaults['research']) ?? defaults.research,
        plan_checker: (globalDefaults['plan_checker']) ?? defaults.plan_checker,
        verifier: (globalDefaults['verifier']) ?? defaults.verifier,
        nyquist_validation: (globalDefaults['nyquist_validation']) ?? defaults.nyquist_validation,
        post_planning_gaps: (globalDefaults['post_planning_gaps'])
          ?? (globalDefaults['workflow'] as Record<string, unknown> | undefined)?.['post_planning_gaps']
          ?? defaults.post_planning_gaps,
        parallelization: (globalDefaults['parallelization']) ?? defaults.parallelization,
        text_mode: (globalDefaults['text_mode']) ?? defaults.text_mode,
        resolve_model_ids: (globalDefaults['resolve_model_ids']) ?? defaults.resolve_model_ids,
        context_window: (globalDefaults['context_window']) ?? defaults.context_window,
        subagent_timeout: (globalDefaults['subagent_timeout']) ?? defaults.subagent_timeout,
        model_overrides: (globalDefaults['model_overrides']) || null,
        models: (globalDefaults['models']) || null,
        granularity: (globalDefaults['granularity']) !== undefined ? globalDefaults['granularity'] : null,
        granularities: (globalDefaults['granularities']) || null,
        planning: (globalDefaults['planning']) || null,
        dynamic_routing: (globalDefaults['dynamic_routing']) || null,
        effort: (globalDefaults['effort']) || null,
        fast_mode: (globalDefaults['fast_mode']) || null,
        agent_skills: (globalDefaults['agent_skills']) || {},
        response_language: (globalDefaults['response_language']) || null,
        // #2069: forward model_policy / model_profile_overrides / runtime so the global-defaults
        // path is at parity with the project-config path (which forwards these three from
        // parsed['…'] at the top of this function). Without these entries, ~/.gsd/defaults.json
        // silently drops them — model_policy/provider/budget etc. are honored when set in a
        // project but ignored when set globally.
        runtime: (globalDefaults['runtime']) || null,
        model_profile_overrides: (globalDefaults['model_profile_overrides']) || null,
        model_policy: (globalDefaults['model_policy']) || null,
      };
      // Branch D: global-defaults
      try {
        return fallback({ config: _applyFederatedOverlay(_globalBaseCfg, globalDefaults, cwd), source: 'global-defaults', degraded: false });
      } catch {
        return fallback({ config: _globalBaseCfg, source: 'global-defaults', degraded: false });
      }
    } catch {
      // Branch E: no global defaults
      try {
        return fallback({ config: _applyFederatedOverlay(defaults, {}, cwd), source: 'builtin-defaults', degraded: false });
      } catch {
        return fallback({ config: defaults, source: 'builtin-defaults', degraded: false });
      }
    }
  }
}

/**
 * loadConfig — backwards-compatible config loading, now a thin wrapper over loadConfigResolved.
 * Returns the config object only; for provenance metadata use loadConfigResolved.
 */
function loadConfig(cwd: string, options: Record<string, unknown> = {}): Record<string, unknown> {
  return loadConfigResolved(cwd, options).config;
}

export = {
  loadConfig,
  loadConfigResolved,
  CONFIG_REASON,
  _warnedUnusableConfig,
  isGitIgnored,
  CONFIG_DEFAULTS,
  _getConfigDefault,
  _getNestedConfigDefault,
  _deepMergeConfig,
  _warnedUnknownConfigKeys,
  _warnUnknownProfileOverrides,
  _resetRuntimeWarningCacheForTests,
  _warnedConfigKeys,
  _gitIgnoredCache,
  RUNTIME_OVERRIDE_TIERS,
  _setFederatedRegistryForTests,
  _resetFederatedRegistryForTests,
};

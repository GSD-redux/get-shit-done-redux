'use strict';

/**
 * Runtime config adapter registry — dispatch table for install-phase config
 * mutations (issue #60), replacing inline `runtime === '...'` branching in
 * bin/install.js.
 *
 * ADR-857 phase 5g drive 2: The hand-kept REGISTRY const has been retired.
 * Values are now read directly from the capability-registry.cjs descriptor
 * (capabilities/<id>/capability.json runtime block) so a single source of
 * truth drives all surfaces.
 *
 * Design notes:
 * - `installSurface` selects which config handler install() runs:
 *     'settings-json'        → fall through to the shared settings.json accumulation.
 *     'codex-toml'           → early-return after writing codex.toml.
 *     'copilot-instructions' → early-return after writing .github/copilot-instructions.md.
 *     'cline-rules'          → early-return after writing .clinerules.
 *     'cursor-hooks-json'    → early-return after writing .cursor/hooks.json (issue #777).
 *     'profile-marker-only'  → early-return after writing only the profile marker.
 * - `writesSharedSettings` is the finishInstall writeSettings gate:
 *     false for codex / copilot / kilo / cursor / windsurf / trae / cline / kimi (legacy exclusion list).
 *     true for all other runtimes.
 * - `finishPermissionWriter` names the finishInstall-phase dedicated config writer:
 *     'opencode'    → writes BOTH shared settings AND its own permissions file.
 *     'kilo'        → writes only its own permissions file.
 *     'antigravity' → writes BOTH shared settings.json permissions.allow AND a
 *                      standalone mcp_config.json MCP companion profile (#2096
 *                      Phase B Upgrades 1+2).
 *     null          → no dedicated permission writer.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runtimes } = require('./capability-registry.cjs') as { runtimes: Record<string, { runtime: Record<string, unknown> | undefined }> };

/** Valid sandboxTier enum values — mirrors the gen-capability-registry validator vocabulary. */
const VALID_SANDBOX_TIERS = new Set(['none', 'codex-agent-sandbox']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConfigInstallSurface =
  | 'settings-json'
  | 'codex-toml'
  | 'copilot-instructions'
  | 'cline-rules'
  | 'cursor-hooks-json'
  | 'profile-marker-only'
  // #2103 — Marketplace/VSIX-distributed hosts (e.g. VS Code) with no CLI
  // install surface at all. Never dispatched through install()/finishInstall()
  // (see the ALLOWED_CONFIG_RUNTIMES filter below, which excludes it).
  | 'none';

type FinishPermissionWriter = 'opencode' | 'kilo' | 'antigravity' | null;

type HooksSurface =
  | 'settings-json'
  | 'codex-hooks-json'
  | 'cursor-hooks-json'
  | 'cline-rules'
  | 'copilot-inline'
  | 'kimi-hooks-toml'
  | 'windsurf-hooks-json'
  | 'none';

interface RuntimeConfigIntent {
  runtime: string;
  installSurface: ConfigInstallSurface;
  writesSharedSettings: boolean;
  finishPermissionWriter: FinishPermissionWriter;
}

/**
 * The full install plan for a runtime: config-intent axes PLUS the three
 * hook axes that install() reads from the capability descriptor.
 * ADR-857 phase 5g capstone — single seam for all install-level descriptor reads.
 */
interface InstallPlan extends RuntimeConfigIntent {
  /** Hook event dialect: 'claude' | 'gemini' | undefined */
  hookEvents: string | undefined;
  /** Extended hook event names registered beyond the core tool events (may be empty). */
  extendedHookEvents: string[];
  /** Which surface owns the hook registration for this runtime. */
  hooksSurface: HooksSurface;
  /** Runtime sandbox tier ('none' | 'codex-agent-sandbox'); gates per-agent sandbox_mode emission. */
  sandboxTier: string;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

type RuntimeDescriptorMap = Record<string, { runtime: Record<string, unknown> | undefined }>;

/**
 * The complete set of 16 supported runtimes for config-adapter dispatch.
 *
 * Excludes runtimes whose installSurface is 'none' (#2103 — e.g. VS Code): a
 * 'none' installSurface means the runtime has NO CLI install surface at all
 * (Marketplace/VSIX-distributed, never dispatched through
 * install()/finishInstall()), so it is not a "config-adapter runtime" by
 * definition. This keeps this set in lockstep with bin/install.js's
 * `allRuntimes` (see the folded:issue-57-runtime-install-no-drift describe
 * block in tests/runtime-config-adapter-registry.test.cjs) without needing a
 * separate hand-kept exclusion list.
 */
const ALLOWED_CONFIG_RUNTIMES: ReadonlySet<string> = new Set(
  Object.entries(runtimes)
    .filter(([, cap]) => cap && cap.runtime && typeof cap.runtime['installSurface'] === 'string' && cap.runtime['installSurface'] !== 'none')
    .map(([id]) => id),
);

/** All valid installSurface values. */
const INSTALL_SURFACES: ReadonlyArray<ConfigInstallSurface> = Object.freeze([
  'settings-json',
  'codex-toml',
  'copilot-instructions',
  'cline-rules',
  'cursor-hooks-json',
  'profile-marker-only',
  'none',
]);

/**
 * Resolve the config adapter intent for a given runtime.
 *
 * Returns a fresh object each call so callers cannot poison the registry by
 * mutating the returned value.
 *
 * @throws {TypeError} if runtime is not a known supported runtime.
 */
function resolveRuntimeConfigIntent(runtime: string): RuntimeConfigIntent {
  const entry = runtimes[runtime]?.runtime;
  if (!entry) throw new TypeError(`Unknown runtime for config adapter: ${runtime}`);
  const permissionWriter = entry['permissionWriter'];
  return {
    runtime,
    installSurface:         entry['installSurface'] as ConfigInstallSurface,
    writesSharedSettings:   entry['writesSharedSettings'] as boolean,
    finishPermissionWriter: permissionWriter == null ? null : permissionWriter as FinishPermissionWriter,
  };
}

function resolveInstallPlanFromRuntimes(runtimeDescriptors: RuntimeDescriptorMap, runtime: string): InstallPlan {
  const desc = runtimeDescriptors[runtime]?.runtime;
  if (!desc) throw new TypeError(`Unknown runtime for install plan: ${runtime}`);
  if (desc['hooksSurface'] == null) {
    throw new TypeError(`runtime.hooksSurface is required for install plan: ${runtime}`);
  }
  const sandboxTier = desc['sandboxTier'];
  if (typeof sandboxTier !== 'string' || !VALID_SANDBOX_TIERS.has(sandboxTier)) {
    throw new TypeError(`Runtime '${runtime}' has a missing or invalid sandboxTier descriptor axis: ${JSON.stringify(sandboxTier)}`);
  }
  const permissionWriter = desc['permissionWriter'];
  return {
    runtime,
    installSurface:         desc['installSurface'] as ConfigInstallSurface,
    writesSharedSettings:   desc['writesSharedSettings'] as boolean,
    finishPermissionWriter: permissionWriter == null ? null : permissionWriter as FinishPermissionWriter,
    hookEvents:             desc['hookEvents'] as string | undefined,
    extendedHookEvents:     Array.isArray(desc['extendedHookEvents']) ? [...desc['extendedHookEvents'] as string[]] : [],
    hooksSurface:           desc['hooksSurface'] as HooksSurface,
    sandboxTier,
  };
}

/**
 * Resolve the complete install plan for a given runtime.
 *
 * Composes the config-intent axes from resolveRuntimeConfigIntent PLUS the
 * three hook axes (hookEvents / extendedHookEvents / hooksSurface) that
 * install() previously read scattered from the capability registry.
 *
 * ADR-857 phase 5g capstone — single typed seam for all install-level
 * descriptor reads. Returns a fresh object each call.
 *
 * @throws {TypeError} if runtime is not a known supported runtime.
 */
function resolveInstallPlan(runtime: string): InstallPlan {
  return resolveInstallPlanFromRuntimes(runtimes, runtime);
}

export = { resolveRuntimeConfigIntent, resolveInstallPlan, resolveInstallPlanFromRuntimes, ALLOWED_CONFIG_RUNTIMES, INSTALL_SURFACES };

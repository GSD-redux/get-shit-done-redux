/**
 * Claude orchestration command router — CLI dispatcher for
 * `gsd-tools claude-orchestration <subcommand>`.
 *
 * #1143 — thin CLI adapter over the pure `claude-orchestration.cjs` module.
 * Lets execute-phase (or any orchestrator) invoke the Workflow-backend
 * detection and the Workflow-script emitter through the standard capability
 * command surface (ADR-959) instead of a bare `require()`.
 *
 * Router signature: { args, cwd, raw, error } — identical to the other host
 * routers; discovered by dispatchCapabilityCommand via the registry's
 * commandFamilies index.
 *
 * Subcommands:
 *   detect-backend [--runtime <id>] [--agent-sdk-version <ver>] [--no-nested-dispatch]
 *       Resolves whether the Workflow backend should activate. Both flags are
 *       OPTIONAL (#2590): `--runtime` falls back to the canonical
 *       `GSD_RUNTIME > config.runtime > 'claude'` chain, and
 *       `--agent-sdk-version` to `GSD_AGENT_SDK_VERSION` then the installed
 *       @anthropic-ai/claude-agent-sdk version. Reads the
 *       `claude_orchestration.*` keys from .planning/config.json. Emits
 *       { available, backend, reason }.
 *
 *   emit-workflow --waves <path> --run-id <id> [--phase-dir <dir>] [--budget <n>] [--executor-model <id>]
 *       Reads a wave/plan manifest JSON file and emits the generated Workflow
 *       script + summary. The manifest shape matches emitWorkflowScript's input:
 *       { waves: [{ id, plans: [{ id, brief, files_modified: string[], use_worktree?: boolean }] }] }.
 *       `use_worktree` defaults to true; pass `false` for a plan the inline path
 *       (execute-phase.md step 2.5) would also keep out of worktree isolation
 *       (submodule-touching plans — #2772 / #2285 finding 1).
 *
 *   resolve-wave-dispatch --waves <path> --run-id <id> [--runtime <id>]
 *       [--agent-sdk-version <ver>] [--no-nested-dispatch] [--phase-dir <dir>]
 *       [--budget <n>] [--executor-model <id>]
 *       #2285 — the single composed seam a PRE-wave dispatch-backend selector
 *       (`execute:wave:pre`) uses: resolves detect-backend + emit-workflow in
 *       ONE call. Emits { backend: 'inline'|'workflow', reason, script?, summary? }.
 *       Fail-closed identically to detect-backend/emit-workflow individually —
 *       any gate miss, or an emit failure on a malformed --waves manifest,
 *       resolves to 'inline' with no script.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import core = require('./claude-orchestration.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import runtimeSlash = require('./runtime-slash.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- model-resolver.cjs is an export= CommonJS module
import modelResolver = require('./model-resolver.cjs');

const { output } = io;
const { detectWorkflowBackend, emitWorkflowScript, resolveWaveDispatch } = core;

const CAPABLE_HOST = { dispatch: { nested: true, background: true } };

interface RouterOpts {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (msg: string, reason?: string) => void;
}

function usage(error: (msg: string, reason?: string) => void): void {
  error(
    'Usage: gsd-tools claude-orchestration <detect-backend|emit-workflow|resolve-wave-dispatch> [...]\n' +
    '  detect-backend [--runtime <id>] [--agent-sdk-version <ver>] [--no-nested-dispatch]\n' +
    '  emit-workflow --waves <path> --run-id <id> [--phase-dir <dir>] [--budget <n>] [--executor-model <id>]\n' +
    '  resolve-wave-dispatch --waves <path> --run-id <id> [--runtime <id>] [--agent-sdk-version <ver>] [--no-nested-dispatch] [--phase-dir <dir>] [--budget <n>] [--executor-model <id>]',
  );
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * Resolve the `claude_orchestration.*` config slice from the project config
 * (federated keys are merged by loadConfig as a nested object), flattened into
 * the dotted-key shape `detectWorkflowBackend`/`resolveWaveDispatch` expect. A
 * config read failure degrades to an empty slice — it must not break the core
 * loop. Shared by `detect-backend` and `resolve-wave-dispatch`.
 */
function resolveFlatClaudeOrchestrationConfig(cwd: string): Record<string, unknown> {
  let claudeSlice: Record<string, unknown> = {};
  try {
    const loaded = configLoader.loadConfig(cwd);
    const slice = loaded['claude_orchestration'];
    if (slice && typeof slice === 'object' && !Array.isArray(slice)) {
      claudeSlice = slice as Record<string, unknown>;
    }
  } catch {
    claudeSlice = {};
  }

  const flatConfig: Record<string, unknown> = {};
  for (const k of Object.keys(claudeSlice)) {
    flatConfig['claude_orchestration.' + k] = claudeSlice[k];
  }
  return flatConfig;
}

/**
 * Resolve the installed Agent SDK version (#2590).
 *
 * The `execute:wave:pre` fragment claimed the orchestrator "has no scriptable
 * way to introspect the live Agent SDK version" and told callers to omit the
 * flag — so gate 5 returned `agent_sdk_version_unknown` on every automated run
 * and the Workflow backend never activated, while `capability state` still
 * reported it `active: true`. That claim is true for BASH, but this router runs
 * in Node: the installed package's own package.json is authoritative and
 * requires no flag at all.
 *
 * Resolution is side-effect-free and fails closed to undefined (gate 5 then
 * declines, exactly as before) rather than guessing a version.
 */
const AGENT_SDK_PKG = path.join('@anthropic-ai', 'claude-agent-sdk', 'package.json');
function resolveInstalledAgentSdkVersion(cwd: string): string | undefined {
  // Walk node_modules up the tree by hand rather than require.resolve: the SDK's
  // `exports` map does not expose './package.json', so require.resolve throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED. Reading the file directly is exports-map
  // independent and cannot execute package code.
  for (const start of [cwd, __dirname]) {
    let dir: string;
    try { dir = path.resolve(start); } catch { continue; }
    for (;;) {
      try {
        const pkgPath = path.join(dir, 'node_modules', AGENT_SDK_PKG);
        if (fs.existsSync(pkgPath)) {
          const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
          if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
        }
      } catch { /* unreadable/malformed — keep walking */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/**
 * Resolve `--runtime`/`--agent-sdk-version`/`--no-nested-dispatch` into the
 * `{ runtimeId, hostIntegration, agentSdkVersion }` triple both `detect-backend`
 * and `resolve-wave-dispatch` pass to the pure detection seam.
 */
function resolveDetectionArgs(args: string[], cwd?: string): { runtimeId: string; hostIntegration: { dispatch: { nested: boolean; background: boolean } }; agentSdkVersion: string | undefined } {
  // #2590: the old fallback chain was `--runtime > GSD_RUNTIME > 'unknown'`,
  // diverging from the canonical `GSD_RUNTIME > config.runtime > 'claude'` used
  // by runtime-slash.resolveRuntime — so ANY manual invocation without
  // --runtime reported `runtime_not_claude` on a perfectly ordinary Claude
  // project. Delegate to the canonical resolver instead of re-deriving it.
  const runtimeId = argValue(args, '--runtime') || runtimeSlash.resolveRuntime(cwd || null);
  // Explicit flag wins (lets a caller pin a version); then the environment;
  // then the actually-installed SDK.
  const agentSdkVersion = argValue(args, '--agent-sdk-version')
    || process.env['GSD_AGENT_SDK_VERSION']
    || resolveInstalledAgentSdkVersion(cwd || process.cwd());
  const noNested = args.includes('--no-nested-dispatch');
  const hostIntegration = noNested ? { dispatch: { nested: false, background: true } } : CAPABLE_HOST;
  return { runtimeId, hostIntegration, agentSdkVersion };
}

/**
 * #2686 — resolve the `gsd-executor` model this dispatch should carry.
 *
 * Defaults from the project config rather than requiring a flag. The Workflow
 * backend previously emitted no model at all, so `model_overrides` /
 * `model_policy` / `model_profile` were silently inert on that path while the
 * inline path honored them. Reading the same source the inline path reads is
 * what makes the two backends agree by construction: an orchestrator that never
 * learns about a new flag would otherwise silently keep the old bug.
 *
 * `--executor-model` exists only to pin/override. Resolution is side-effect-free
 * and fails closed to `undefined` (emission then omits the key, i.e. exactly the
 * pre-#2686 output) rather than guessing a model.
 */
function resolveExecutorModel(args: string[], cwd: string): string | undefined {
  const pinned = argValue(args, '--executor-model');
  if (pinned !== undefined) return pinned;
  try {
    const resolved = modelResolver.resolveModelInternal(cwd, 'gsd-executor') as unknown;
    return typeof resolved === 'string' ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Discriminated result for readWavesManifest — see doc comment below. */
type WavesReadResult =
  | { ok: true; waves: unknown }
  | { ok: false };

/**
 * Read and parse a `--waves <path>` manifest file.
 *
 * #2285 finding 2: a real read/parse failure (`ok:false`) is DISTINCT from a
 * manifest that parsed fine but has no top-level `waves` key (`ok:true, waves:
 * undefined`) — collapsing both into the same sentinel made the missing-key
 * case exit 0 with ZERO output (fail-silent), breaking the "exit 0 => parseable
 * JSON verdict" contract callers rely on. Only the `ok:false` (read/parse threw)
 * case calls `error(...)` and should short-circuit the caller; `ok:true` with a
 * missing/malformed `waves` value must flow through to `emitWorkflowScript`'s
 * own validation (matching how `{"waves": null}` already behaves) so the caller
 * emits an explicit, non-empty verdict instead of silently doing nothing.
 */
function readWavesManifest(wavesPath: string, error: (msg: string, reason?: string) => void): WavesReadResult {
  try {
    const content = fs.readFileSync(path.resolve(wavesPath), 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return { ok: true, waves: parsed['waves'] };
  } catch (e) {
    error('could not read/parse --waves file "' + wavesPath + '": ' + (e instanceof Error ? e.message : String(e)));
    return { ok: false };
  }
}

/**
 * Detect whether the Workflow backend should activate for the current/given
 * runtime. Reads `claude_orchestration.*` from the project config; runtime and
 * SDK version come from flags (the orchestrator already knows these) or env.
 */
function cmdDetectBackend(args: string[], cwd: string, raw: boolean): void {
  const { runtimeId, hostIntegration, agentSdkVersion } = resolveDetectionArgs(args, cwd);
  const flatConfig = resolveFlatClaudeOrchestrationConfig(cwd);
  const result = detectWorkflowBackend({ runtimeId, hostIntegration, config: flatConfig, agentSdkVersion });
  output(result, raw);
}

/**
 * Emit a Workflow script from a wave/plan manifest file.
 */
function cmdEmitWorkflow(args: string[], cwd: string, raw: boolean, error: (msg: string, reason?: string) => void): void {
  const wavesPath = argValue(args, '--waves');
  const runId = argValue(args, '--run-id');
  const phaseDir = argValue(args, '--phase-dir') || '.planning/phases/current';
  const budgetRaw = argValue(args, '--budget');

  if (!wavesPath) {
    error('emit-workflow requires --waves <path>');
    return;
  }
  if (!runId) {
    error('emit-workflow requires --run-id <id>');
    return;
  }

  const read = readWavesManifest(wavesPath, (msg) => error('emit-workflow: ' + msg));
  if (!read.ok) return; // read/parse failure — error() already surfaced it loudly above

  const budgetTokens = budgetRaw !== undefined ? parseInt(budgetRaw, 10) : undefined;
  const budget = (typeof budgetTokens === 'number' && !Number.isNaN(budgetTokens)) ? budgetTokens : undefined;

  const result = emitWorkflowScript({
    phaseDir,
    runId,
    waves: read.waves as EmitInput['waves'],
    budgetTokens: budget,
    executorModel: resolveExecutorModel(args, cwd),
  });

  if (!result.ok) {
    error('emit-workflow: ' + result.reason);
    return;
  }
  output({ script: result.script, summary: result.summary }, raw);
}

/**
 * #2285 — the single composed seam a PRE-wave dispatch-backend selector
 * (`execute:wave:pre`) uses: resolves `detect-backend` + `emit-workflow` in
 * ONE call via `resolveWaveDispatch`. Emits
 * `{ backend: 'inline'|'workflow', reason, script?, summary? }`.
 */
function cmdResolveWaveDispatch(args: string[], cwd: string, raw: boolean, error: (msg: string, reason?: string) => void): void {
  const wavesPath = argValue(args, '--waves');
  const runId = argValue(args, '--run-id');
  const phaseDir = argValue(args, '--phase-dir') || '.planning/phases/current';
  const budgetRaw = argValue(args, '--budget');

  if (!wavesPath) {
    error('resolve-wave-dispatch requires --waves <path>');
    return;
  }
  if (!runId) {
    error('resolve-wave-dispatch requires --run-id <id>');
    return;
  }

  const read = readWavesManifest(wavesPath, (msg) => error('resolve-wave-dispatch: ' + msg));
  if (!read.ok) return; // read/parse failure — error() already surfaced it loudly above

  const { runtimeId, hostIntegration, agentSdkVersion } = resolveDetectionArgs(args, cwd);
  const flatConfig = resolveFlatClaudeOrchestrationConfig(cwd);

  const budgetTokens = budgetRaw !== undefined ? parseInt(budgetRaw, 10) : undefined;
  const budget = (typeof budgetTokens === 'number' && !Number.isNaN(budgetTokens)) ? budgetTokens : undefined;

  const result = resolveWaveDispatch({
    runtimeId,
    hostIntegration,
    config: flatConfig,
    agentSdkVersion,
    phaseDir,
    runId,
    waves: read.waves as EmitInput['waves'],
    budgetTokens: budget,
    executorModel: resolveExecutorModel(args, cwd),
  });

  output(result, raw);
}

// Re-declared minimal input type for the cast above (avoids importing private types).
interface EmitInput {
  waves: Array<{ id: string; plans: Array<{ id: string; brief: string; files_modified: string[]; use_worktree?: boolean }> }>;
}

function routeClaudeOrchestrationCommand(opts: RouterOpts): void {
  const { args, cwd, raw, error } = opts;
  // args[0] is the family ('claude-orchestration'); the subcommand is args[1].
  const subcommand = args[1];
  if (subcommand === 'detect-backend') {
    cmdDetectBackend(args, cwd, raw);
  } else if (subcommand === 'emit-workflow') {
    cmdEmitWorkflow(args, cwd, raw, error);
  } else if (subcommand === 'resolve-wave-dispatch') {
    cmdResolveWaveDispatch(args, cwd, raw, error);
  } else {
    usage(error);
  }
}

export = { routeClaudeOrchestrationCommand };

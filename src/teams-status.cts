/**
 * Teams Status Module — issue #1355
 *
 * Read-only detector for claude-code's experimental agent-teams feature.
 * Exposes a PURE core function (env injected, no process.env/disk inside) and
 * a thin CLI wrapper that reuses resolveRuntime from runtime-slash.cjs.
 *
 * Exports:
 *   resolveTeamsStatus({ runtime, env }) → TeamsStatus
 *   cmdTeamsStatus(cwd, opts)  — I/O entry point
 *
 * resolveTeamsStatus is PURE: env and runtime are injected, no process.env or
 * disk access inside the function. Pass process.env explicitly at call sites.
 *
 * cmdTeamsStatus is the I/O handler. It reads process.env, resolves the
 * runtime via resolveRuntime(cwd) from runtime-slash.cjs (GSD_RUNTIME →
 * config.runtime → 'claude' precedence), then:
 *   - default: prints JSON.stringify(status) to stdout via io.output, exits 0.
 *   - --active: prints nothing, exits 0 if status.active, exit 1 otherwise.
 *
 * Strictly read-only — no config writes, no disk mutation.
 *
 * Dependencies:
 *   - ./io.cjs             (output)
 *   - ./runtime-slash.cjs  (resolveRuntime)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output: coreOutput } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cliExitModule = require('./cli-exit.cjs');
const { ExitError } = cliExitModule;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TeamsStatus {
  /** true only when env flag is strictly-truthy AND runtime === 'claude' */
  active: boolean;
  /** resolved runtime name */
  runtime: string;
  /** true when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is set to a truthy value */
  env_present: boolean;
  /** human-readable source description */
  source: 'on: env' | 'off: flag absent' | 'off: non-claude';
}

// ─── Pure core ────────────────────────────────────────────────────────────────

/**
 * Resolve the agent-teams status from injected runtime and env.
 *
 * Strict truthiness: only '1' and 'true' (case-insensitive, trimmed) are on.
 * '0', 'false', '', and unset are all off.
 *
 * @param opts.runtime  The resolved runtime name (e.g. 'claude', 'codex')
 * @param opts.env      The environment map to read from (typically process.env)
 */
export function resolveTeamsStatus(opts: { runtime: string; env: NodeJS.ProcessEnv }): TeamsStatus {
  const raw = (opts.env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'] ?? '').trim().toLowerCase();
  const envOn = raw === '1' || raw === 'true';          // strict: never '0'/'false'/'' as on
  const isClaude = opts.runtime === 'claude';
  const source = !isClaude ? 'off: non-claude' : (envOn ? 'on: env' : 'off: flag absent');
  return { active: envOn && isClaude, runtime: opts.runtime, env_present: envOn, source };
}

// ─── CLI command handler ──────────────────────────────────────────────────────

/**
 * Command entry point: resolve runtime via resolveRuntime(cwd), read process.env,
 * call resolveTeamsStatus, and emit the result.
 *
 * @param cwd       Project root directory (used by resolveRuntime for config.json)
 * @param opts      Command options
 * @param opts.active  When true: print nothing, exit 0 if active, exit 1 otherwise
 */
export function cmdTeamsStatus(cwd: string, opts: { active?: boolean }): void {
  // Resolve runtime via the canonical precedence:
  //   GSD_RUNTIME → config.runtime → 'claude'
  // Reuses resolveRuntime from runtime-slash.cjs — no reimplementation.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtimeSlash = require('./runtime-slash.cjs') as {
    resolveRuntime: (projectDir: string | null | undefined) => string;
  };
  const runtime = runtimeSlash.resolveRuntime(cwd);

  const status = resolveTeamsStatus({ runtime, env: process.env });

  if (opts.active) {
    // --active mode: no output, exit code encodes the boolean
    throw new ExitError(status.active ? 0 : 1);
  }

  // Default: emit JSON to stdout via io.output, exit 0
  coreOutput(status, false);
}

/**
 * Shell Command Projection Module
 *
 * Tracer-bullet seam for runtime-aware projection of serialized command text
 * that GSD writes into runtime config or prints for copy/paste. This module
 * does NOT execute commands; it only renders command text for external shells
 * and runtimes.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/shell-command-projection.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import path from 'node:path';
import fs from 'node:fs';
// Use non-destructured namespace import so test-time mock.method(childProcess, 'spawnSync')
// can intercept calls from this seam — destructured imports capture references
// at load time and become un-mockable.
import childProcess from 'node:child_process';

/**
 * Convert a filesystem path to POSIX form (forward slashes) by translating the
 * platform-native separator. Single seam for native→POSIX conversion.
 *
 * Prefer this over `p.replace(/\\/g, '/')`: the regex form hardcodes both
 * separators and corrupts POSIX paths containing a literal backslash (a legal
 * filename character). Splitting on `path.sep` only ever touches real
 * separators — a no-op on POSIX, `\`→`/` on Windows.
 */
export function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

/**
 * Convert a filesystem path to the platform-native separator form. No-op on
 * POSIX; `/`→`\` on Windows. Prefer this over a
 * `process.platform === 'win32' ? p.replace(/\//g, '\\') : p` ternary.
 */
export function toNativePath(p: string): string {
  return p.split(path.posix.sep).join(path.sep);
}

/**
 * Normalize ALL backslashes to forward slashes, unconditionally and independent
 * of the running OS. Use this when emitting a path into a POSIX/bash target
 * (which may differ from the running platform — e.g. generating a Windows config
 * on a Linux runner) or when parsing input whose separators are unpredictable.
 *
 * Contrast `toPosixPath`, which is running-OS-relative (splits on `path.sep`) and
 * is for *this machine's* filesystem paths. Do NOT use `toPosixPath` for
 * target-platform projection — on a Linux runner it would not convert a
 * Windows-target path's backslashes.
 */
export function posixNormalize(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Return true when a managed hook command must be prefixed with PowerShell's
 * call operator so a quoted executable token is invokable by the target
 * runtime/shell combination.
 *
 * The `&`/no-`&` decision is keyed on the **effective hook-execution shell**
 * (`opts.hookShell`), not on runtime alone — a single runtime (Claude Code)
 * can host either Git Bash or PowerShell on Windows, and no single static
 * command string is valid in both (#2236):
 * - Git Bash: `"node.exe" "hook.js"` works; `& "node.exe" …` → syntax error.
 * - PowerShell: `& "node.exe" "hook.js"` works; bare `"node.exe" …` →
 *   `Unexpected token`.
 *
 * Default is `false` (Git Bash form) for backward compatibility. Set
 * `opts.hookShell = 'powershell'` to emit the PowerShell call-operator form.
 */
export function hookCommandNeedsPowerShellCallOperator(opts: { platform?: string; runtime?: string; hookShell?: string } = {}): boolean {
  return opts.hookShell === 'powershell';
}

/**
 * Project a fully-assembled hook command string for the target runtime.
 */
export function formatHookCommandForRuntime(command: string, opts: { platform?: string; runtime?: string; hookShell?: string } = {}): string {
  return hookCommandNeedsPowerShellCallOperator(opts) ? `& ${command}` : command;
}

// #166/#580: Claude Code on Windows executes hook command strings inside Git
// Bash. A `.sh` hook wrapped with an explicit bash.exe path makes bash try to
// exec bash itself ("C:/.../bash.exe: cannot execute binary file"). Both install
// paths — global (buildHookCommand) and local (buildLocalShellHookCommand) — must
// drop the bash runner in this case and emit only the anchored script path.
// Centralized here so the two paths cannot silently drift apart again: the local
// path missed this guard and reintroduced the #166/#377 failure (#580).
export function shellHookOmitsBashRunner({ platform, runtime = 'generic', isShellHook = false }: { platform?: string; runtime?: string; isShellHook?: boolean } = {}): boolean {
  const p = platform ?? process.platform;
  return p === 'win32' && runtime === 'claude' && isShellHook;
}

// Builds the command string for a local-install managed `.sh` hook. Mirrors the
// global buildHookCommand path but uses the $CLAUDE_PROJECT_DIR-anchored prefix
// instead of an absolute configDir. On Claude/Windows the bash runner is dropped
// (see shellHookOmitsBashRunner) and the anchored script path is emitted alone —
// matching the global path. Elsewhere the resolved bash runner is required; a
// null runner yields null so callers skip registration instead of emitting a
// broken hook (#3393).
export function buildLocalShellHookCommand({ localPrefix, hookFile, bashRunner, runtime = 'generic', platform = process.platform }: {
  localPrefix?: string | null;
  hookFile?: string | null;
  bashRunner?: string | null;
  runtime?: string;
  platform?: string;
}): string | null {
  if (!localPrefix || !hookFile) return null;
  const scriptPath = `${localPrefix}/hooks/${hookFile}`;
  if (shellHookOmitsBashRunner({ platform, runtime, isShellHook: true })) {
    return formatHookCommandForRuntime(scriptPath, { platform, runtime });
  }
  if (!bashRunner) return null;
  return projectShellCommandText({
    runnerToken: bashRunner,
    argTokens: [scriptPath],
    runtime,
    platform,
  });
}

/**
 * Project a managed hook script path token for serialized shell commands.
 * Windows managed hook commands normalize to forward slashes so the same path
 * survives JSON/TOML/config surfaces consistently.
 */
export function formatManagedHookScriptToken(scriptPath: string, opts: { platform?: string } = {}): string | null {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return null;
  return JSON.stringify(posixNormalize(scriptPath));
}

export function projectLocalHookPrefix({ runtime: _runtime = 'claude', dirName, hookPathStyle }: { runtime?: string; dirName?: string | null; hookPathStyle?: string | null }): string | undefined | null {
  if (!dirName) return dirName;
  // Descriptor-driven (ADR-1239 / #2096): folded from a hardcoded
  // `runtime === 'antigravity'` literal into the runtime's declared
  // `hostBehaviors.hookPathStyle`. Runtimes that always run project hooks
  // with the project dir as cwd (Antigravity today) declare 'raw' and get
  // the bare dirName; every other runtime keeps the $CLAUDE_PROJECT_DIR-
  // anchored prefix. `runtime` itself is now unused here but stays in the
  // signature for call-site/back-compat parity (kept `_`-prefixed to
  // satisfy no-unused-vars).
  return (hookPathStyle === 'raw')
    ? dirName
    : `"$CLAUDE_PROJECT_DIR"/${dirName}`;
}

export function projectPortableHookBaseDir({ configDir, homeDir }: { configDir?: string | null; homeDir?: string | null }): string {
  const normalizedConfigDir = posixNormalize(String(configDir || ''));
  const normalizedHome = posixNormalize(String(homeDir || ''));
  if (!normalizedConfigDir || !normalizedHome) return normalizedConfigDir;
  return normalizedConfigDir.startsWith(normalizedHome)
    ? '$HOME' + normalizedConfigDir.slice(normalizedHome.length)
    : normalizedConfigDir;
}

export function projectShellCommandText({
  runnerToken,
  argTokens = [],
  runtime = 'generic',
  platform = process.platform,
  hookShell,
}: {
  runnerToken?: string | null;
  argTokens?: (string | null | undefined)[];
  runtime?: string;
  platform?: string;
  hookShell?: string;
}): string | null {
  if (!runnerToken) return null;
  const parts = [runnerToken, ...argTokens.filter(Boolean)] as string[];
  return formatHookCommandForRuntime(parts.join(' '), { platform, runtime, hookShell });
}

export function projectManagedHookCommand({ absoluteRunner, scriptPath, runtime = 'generic', platform = process.platform, hookShell }: {
  absoluteRunner?: string | null;
  scriptPath?: string | null;
  runtime?: string;
  platform?: string;
  hookShell?: string;
}): string | null {
  if (!absoluteRunner || !scriptPath) return null;
  const normalizedScriptPath = platform === 'win32' ? posixNormalize(scriptPath) : scriptPath;
  return projectShellCommandText({
    runnerToken: absoluteRunner,
    argTokens: [JSON.stringify(normalizedScriptPath)],
    runtime,
    platform,
    hookShell,
});
}

const MANAGED_HOOK_BASENAMES_BY_SURFACE: Record<string, Set<string>> = {
  'settings-json': new Set([
    'gsd-check-update.js',
    'gsd-config-reload.js',
    'gsd-statusline.js',
    'gsd-context-monitor.js',
    'gsd-prompt-guard.js',
    'gsd-read-guard.js',
    'gsd-read-injection-scanner.js',
    'gsd-update-banner.js',
    'gsd-workflow-guard.js',
  ]),
  'codex-toml': new Set([
    'gsd-check-update.js',
  ]),
};

const MANAGED_HOOK_COMMAND_BASENAMES_BY_SURFACE: Record<string, Set<string>> = {
  'settings-json': new Set([
    'gsd-check-update.js',
    'gsd-config-reload.js',
    'gsd-statusline.js',
    'gsd-context-monitor.js',
    'gsd-prompt-guard.js',
    'gsd-read-guard.js',
    'gsd-read-injection-scanner.js',
    'gsd-update-banner.js',
    'gsd-workflow-guard.js',
    'gsd-session-state.sh',
    'gsd-validate-commit.sh',
    'gsd-phase-boundary.sh',
  ]),
  'codex-toml': new Set([
    'gsd-check-update.js',
  ]),
  'codex-hooks-json': new Set([
    'gsd-check-update.js',
    // #3426: Windows .cmd shim for Codex hook — must be treated as managed so
    // reconcileCodexHooksJsonSessionStart can replace stale node-runner commands
    // with the .cmd shim on reinstall (and vice-versa on cross-platform moves).
    'gsd-check-update.cmd',
    // #772: context-monitor is now registered for Codex SubagentStart/Stop/PostToolUse.
    'gsd-context-monitor.js',
    // #772: Windows .cmd shim for gsd-context-monitor — same #3426 pattern.
    'gsd-context-monitor.cmd',
  ]),
};

const LEGACY_MANAGED_HOOK_ALIASES_BY_SURFACE: Record<string, Set<string>> = {
  'codex-toml': new Set([
    'gsd-update-check.js',
  ]),
  'codex-hooks-json': new Set([
    'gsd-update-check.js',
  ]),
};

function managedHookSurfaceSet(surface: string = 'settings-json'): Set<string> {
  return MANAGED_HOOK_BASENAMES_BY_SURFACE[surface] || MANAGED_HOOK_BASENAMES_BY_SURFACE['settings-json'];
}

export function isManagedHookBasename(scriptPathOrBasename: string | null | undefined, opts: { surface?: string } = {}): boolean {
  if (!scriptPathOrBasename) return false;
  const surface = opts.surface || 'settings-json';
  const basename = String(scriptPathOrBasename).split(/[\\/]/).pop() || '';
  return managedHookSurfaceSet(surface).has(basename);
}

function managedHookCommandSurfaceSet(surface: string = 'settings-json', includeLegacyAliases: boolean = false): Set<string> {
  const base = MANAGED_HOOK_COMMAND_BASENAMES_BY_SURFACE[surface]
    || MANAGED_HOOK_COMMAND_BASENAMES_BY_SURFACE['settings-json'];
  if (!includeLegacyAliases) return base;
  const aliases = LEGACY_MANAGED_HOOK_ALIASES_BY_SURFACE[surface];
  if (!aliases || aliases.size === 0) return base;
  return new Set([...base, ...aliases]);
}

export function isManagedHookCommand(commandText: unknown, opts: { surface?: string; includeLegacyAliases?: boolean; configDir?: string; args?: unknown[] } = {}): boolean {
  if (typeof commandText !== 'string') return false;
  const surface = opts.surface || 'settings-json';
  const includeLegacyAliases = opts.includeLegacyAliases === true;
  const managedBasenames = managedHookCommandSurfaceSet(surface, includeLegacyAliases);
  if (!managedBasenames || managedBasenames.size === 0) return false;

  // args-form check: the managed hook filename may appear in args[] rather than
  // in command when a windowless launcher wraps the Node invocation. (#976)
  // Only treat as managed when an arg basename matches the managed hook set —
  // prevents false-positives for non-GSD entries that happen to share a path segment.
  if (Array.isArray(opts.args) && opts.args.length > 0) {
    for (const arg of opts.args) {
      if (typeof arg !== 'string') continue;
      const argBasename = posixNormalize(arg).split('/').pop() || '';
      if (isManagedHookBasename(argBasename, { surface })) return true;
    }
  }

  const normalizedCommand = posixNormalize(commandText);

  if (typeof opts.configDir === 'string' && opts.configDir.length > 0) {
    const normalizedHooksDir = `${posixNormalize(path.join(opts.configDir, 'hooks'))}/`;
    if (!normalizedCommand.includes(normalizedHooksDir)) return false;
  }

  for (const basename of managedBasenames) {
    const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[\\\\/\\s"'` + '`' + `])${escapedBasename}(?=$|[\\s"'` + '`' + `])`);
    if (pattern.test(normalizedCommand)) return true;
  }
  return false;
}

/**
 * Detect a `"$VAR"/rest` anchored hook-script token — a path whose leading
 * shell variable is already double-quoted with the remainder left bare (the
 * shape `projectLocalHookPrefix` emits for local installs, e.g.
 * `"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-x.js`). Such a token is ALREADY a
 * valid, correctly-quoted shell argument and must never be re-quoted.
 */
const ANCHORED_HOOK_SCRIPT_TOKEN = /^"\$[A-Za-z_][A-Za-z0-9_]*"\//;

/**
 * Projection helper for legacy settings.json hook rewrites.
 *
 * Non-Windows keeps the original script token shape when provided (single
 * quote / bareword / quoted), while Windows normalizes to double-quoted
 * forward-slash path tokens for stable cross-shell behavior.
 */
export function projectLegacySettingsHookCommand({
  absoluteRunner,
  scriptPath,
  scriptToken,
  runtime = 'generic',
  platform = process.platform,
}: {
  absoluteRunner?: string | null;
  scriptPath?: string | null;
  scriptToken?: string | null;
  runtime?: string;
  platform?: string;
}): string | null {
  if (!absoluteRunner || !scriptPath) return null;
  const normalizedScriptPath = platform === 'win32' ? posixNormalize(scriptPath) : scriptPath;
  // #1693: a script path already carrying a `"$CLAUDE_PROJECT_DIR"`-anchored
  // quoted prefix (local installs) is already a valid shell token — only the
  // variable is quoted, the rest is bare. JSON.stringify-ing it on Windows
  // yields `"\"$CLAUDE_PROJECT_DIR\"/..."` (escaped quotes inside an outer
  // quote); node then receives an argument that *starts* with a `"`, treats it
  // as relative, and dies with MODULE_NOT_FOUND. Emit anchored tokens verbatim;
  // only bare absolute paths (which may contain spaces, e.g. "Program Files")
  // need the JSON.stringify quoting. Scoped to win32: the non-Windows branch
  // already preserves the caller's `scriptToken` (which is the bare anchored
  // token for these inputs), so it never had the double-quote bug.
  const commandScriptToken = platform === 'win32'
    ? (ANCHORED_HOOK_SCRIPT_TOKEN.test(normalizedScriptPath)
        ? normalizedScriptPath
        : JSON.stringify(normalizedScriptPath))
    : (scriptToken || JSON.stringify(normalizedScriptPath));
  return projectShellCommandText({
    runnerToken: absoluteRunner,
    argTokens: [commandScriptToken],
    runtime,
    platform,
  });
}

export function escapeTomlDoubleQuotedString(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function projectCodexHookTomlCommand({ absoluteRunner, scriptPath, platform = process.platform }: {
  absoluteRunner?: string | null;
  scriptPath?: string | null;
  platform?: string;
}): string | null {
  const command = projectManagedHookCommand({
    absoluteRunner,
    scriptPath,
    runtime: 'codex',
    platform,
  });
  return command === null ? null : escapeTomlDoubleQuotedString(command);
}

export function escapePowerShellSingleQuoted(value: unknown): string {
  return String(value).replace(/'/g, "''");
}

export function escapePosixDoubleQuoted(value: unknown): string {
  return String(value).replace(/[\\$"`]/g, '\\$&');
}

export function escapeSingleQuotedShellLiteral(value: unknown): string {
  return String(value).replace(/'/g, "'\\''");
}

interface ShellAction {
  label: string | null;
  shell: string;
  command: string;
}

export function renderShellActionLines(shellActions: ShellAction[] = []): string[] {
  return shellActions.map((action) => {
    if (!action || !action.command) return '';
    return action.label ? `${action.label}: ${action.command}` : action.command;
  }).filter(Boolean);
}

export function projectPathActionProjection({
  mode = 'repair',
  targetDir,
  platform = process.platform,
}: {
  mode?: string;
  targetDir?: string | null;
  platform?: string;
}): { shellActions: ShellAction[]; actionLines: string[] } {
  if (!targetDir) return { shellActions: [], actionLines: [] };

  const isWin32 = platform === 'win32';

  let shellActions: ShellAction[];
  if (isWin32) {
    const psTargetDir = escapePowerShellSingleQuoted(targetDir);
    const bashTargetDir = escapeSingleQuotedShellLiteral(posixNormalize(String(targetDir)));
    shellActions = [
      {
        label: 'PowerShell',
        shell: 'powershell',
        command: `[Environment]::SetEnvironmentVariable('PATH', '${psTargetDir};' + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')`,
      },
      {
        label: 'cmd.exe',
        shell: 'cmd',
        command: `powershell -Command "[Environment]::SetEnvironmentVariable('PATH', '${psTargetDir};' + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')"`,
      },
      {
        label: 'Git Bash',
        shell: 'bash',
        command: `echo 'export PATH="${bashTargetDir}:$PATH"' >> ~/.bashrc`,
      },
    ];
  } else if (mode === 'persist') {
    const bashTargetDir = escapeSingleQuotedShellLiteral(String(targetDir));
    shellActions = [
      {
        label: 'zsh',
        shell: 'zsh',
        command: `echo 'export PATH="${bashTargetDir}:$PATH"' >> ~/.zshrc`,
      },
      {
        label: 'bash',
        shell: 'bash',
        command: `echo 'export PATH="${bashTargetDir}:$PATH"' >> ~/.bashrc`,
      },
      // #323: fish has no `export`/`$PATH`-list syntax. `fish_add_path` is the
      // fish-native API (>= fish 3.2, 2021) that persists to the universal
      // variable store and de-duplicates. The directory is single-quoted with
      // the same POSIX literal escaping as the zsh/bash siblings — `'\''` is
      // also a valid escaped single quote in fish between quote spans.
      {
        label: 'fish',
        shell: 'fish',
        command: `fish_add_path '${bashTargetDir}'`,
      },
    ];
  } else {
    const posixTargetDir = escapePosixDoubleQuoted(targetDir);
    shellActions = [
      {
        label: null,
        shell: 'posix',
        command: `export PATH="${posixTargetDir}:$PATH"`,
      },
    ];
  }

  return {
    shellActions,
    actionLines: renderShellActionLines(shellActions),
  };
}

export function projectPersistentPathExportActions({ targetDir, platform = process.platform }: {
  targetDir?: string | null;
  platform?: string;
}): { shellActions: ShellAction[] } {
  const projected = projectPathActionProjection({
    mode: 'persist',
    targetDir,
    platform,
  });
  return { shellActions: projected.shellActions };
}


// ─── Subprocess dispatch ──────────────────────────────────────────────────────

export interface SpawnResultOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error: Error | null;
  timedOut: boolean;
}

/**
 * Returns true when a spawn/exec result indicates the subprocess was killed
 * by a timeout, i.e. it never completed and reported a real answer. This is
 * the single shared definition of "did this subprocess time out" — worktree
 * safety (src/worktree-safety.cts) and worktree base-ref detection
 * (src/worktree-base-ref.cts) both call this instead of maintaining their
 * own copies (#3050 — "Generative Fix Divergence").
 *
 * Only `error.code === 'ETIMEDOUT'` is checked. Node.js guarantees this
 * cross-platform when `spawnSync`'s `timeout` option fires. The `signal ===
 * 'SIGTERM'` check some earlier code paired with it is platform-fragile —
 * Windows does not necessarily report SIGTERM the same way — and pairing it
 * in as a REQUIRED conjunct risks a false NEGATIVE (a timeout that silently
 * fails to trip the guard) on that platform. There is no false-positive risk
 * from dropping it: an externally-delivered SIGTERM (not a timeout) leaves
 * `error` null, so `error.code === 'ETIMEDOUT'` alone still won't match it.
 */
export function isSpawnTimeout(result: { error?: unknown }): boolean {
  return (result.error as NodeJS.ErrnoException | null | undefined)?.code === 'ETIMEDOUT';
}

function _spawnResult(result: { error?: NodeJS.ErrnoException | null; status?: number | null; stdout?: Buffer | string | null; stderr?: Buffer | string | null; signal?: NodeJS.Signals | null }, program: string): SpawnResultOutput {
  if (result.error && result.error.code === 'ENOENT') {
    return { exitCode: 127, stdout: '', stderr: `${program}: not found`, signal: null, error: result.error, timedOut: false };
  }
  const signal = result.signal ?? null;
  const error = result.error ?? null;
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? '').toString().trim(),
    stderr: (result.stderr ?? '').toString().trim(),
    signal,
    error,
    // Reuse the single shared timeout predicate (isSpawnTimeout, below) rather
    // than re-deriving it here — see that function's docstring for why only
    // error.code === 'ETIMEDOUT' is checked (not signal === 'SIGTERM').
    timedOut: isSpawnTimeout({ error }),
  };
}

export function execGit(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): SpawnResultOutput {
  // Non-interactive defaults: a hung credential prompt or terminal-input
  // probe must surface as a timeout, not block the tool forever. Callers
  // can override via opts.env.
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    ...(opts.env || {}),
  };
  const result = childProcess.spawnSync('git', args, {
    cwd: opts.cwd,
    env,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 10_000,
    windowsHide: true,
  });
  return _spawnResult(result, 'git');
}

export function execNpm(args: string[], opts: { cwd?: string; timeout?: number } = {}): SpawnResultOutput {
  const result = childProcess.spawnSync('npm', args, {
    cwd: opts.cwd,
    shell: process.platform === 'win32',
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout ?? 15_000,
    windowsHide: true,
  });
  return _spawnResult(result, 'npm');
}

export function execTool(program: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): SpawnResultOutput {
  const result = childProcess.spawnSync(program, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
    windowsHide: true,
  });
  return _spawnResult(result, program);
}

/**
 * Result shape for {@link dispatchGsdCommand}. Modeled on the existing
 * `{exitCode,stdout,stderr,signal,error}` seam above, but flattened to the
 * fields callers actually need (never leaks a raw Error/signal — see
 * `timedOut`), per the "Unbounded Subprocesses" contract (CLAUDE.md):
 * degrade to a structured result on timeout/ENOENT, never throw.
 */
export interface DispatchGsdCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Resolve the absolute path to gsd-tools.cjs relative to THIS module.
 *
 * This file compiles to gsd-core/bin/lib/shell-command-projection.cjs — a
 * sibling of gsd-core/bin/gsd-tools.cjs — so the relative walk-up is stable
 * regardless of install location (global/local/dev-repo layouts all ship
 * gsd-core/bin/ as a unit).
 */
export function resolveGsdToolsPath(): string {
  return path.resolve(__dirname, '..', 'gsd-tools.cjs');
}

/**
 * Subprocess-shim dispatch to gsd-tools.cjs (ADR-1239 #2102 Stage 2).
 *
 * No fully-populated in-process command-routing hub exists anywhere in the
 * tree — every `createHub()` caller (cjs-command-router-adapter.cts,
 * phase-command-router.cts, command-routing-hub.cts's own tests) builds a
 * single-family hub for its own narrow purpose. The ONLY dispatch path that
 * covers the FULL family/subcommand surface is the gsd-tools.cjs CLI itself.
 * This mirrors the SUBPROCESS-REUSE precedent already established for the
 * OpenCode/Kilo hook bridge (see .opencode/plugins/gsd-core.js header:
 * "Architecture: SUBPROCESS REUSE ... spawns existing hook scripts as child
 * processes") — the same pattern, applied to command dispatch instead of
 * hook dispatch.
 *
 * Output-flag choice (verified by direct invocation — see #2102 dispatch
 * notes for the sample invocations): always pass `--raw` (undecorated,
 * programmatically-consumable stdout on success) and `--json-errors` (a
 * structured `{ok:false,reason,message}` JSON object on stderr, with a
 * non-zero exit, instead of a free-text "Error: ..." line). Both are global
 * flags accepted by every gsd-tools.cjs family/subcommand, so passing them
 * unconditionally is safe for the full command surface.
 *
 * `family` maps 1:1 onto gsd-tools.cjs's first positional argv token;
 * `subcommand` (when present) onto the second — e.g.
 * `{family:'phase', subcommand:'add'}` → `gsd-tools.cjs phase add`. An empty
 * `subcommand` is omitted entirely (some families, e.g. `config-path`, take
 * no subcommand).
 *
 * NEVER throws. Degrades to `{ ok:false, ... }` on:
 *   - a missing/invalid "family" (validated locally, no subprocess spawned)
 *   - ENOENT / a missing gsd-tools.cjs (via the injectable `gsdToolsPath`)
 *   - a wall-clock timeout (`timedOut:true`, via the shared `isSpawnTimeout`
 *     predicate defined above in this file — also used by worktree-safety.cts
 *     and worktree-base-ref.cts)
 *   - any other unanticipated throw from the underlying spawn (defensive
 *     try/catch — execTool itself is spawnSync-based and does not throw).
 */
export function dispatchGsdCommand({
  family,
  subcommand,
  args = [],
  cwd,
  timeout = 30_000,
  gsdToolsPath,
}: {
  family?: string;
  subcommand?: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
  gsdToolsPath?: string;
} = {}): DispatchGsdCommandResult {
  if (typeof family !== 'string' || family.length === 0) {
    return {
      ok: false,
      stdout: '',
      stderr: 'dispatchGsdCommand requires a non-empty string "family".',
      code: null,
      timedOut: false,
    };
  }

  const resolvedCwd = cwd || process.cwd();
  const toolsPath = gsdToolsPath || resolveGsdToolsPath();
  const argv = [
    toolsPath,
    family,
    ...(subcommand ? [subcommand] : []),
    ...(Array.isArray(args) ? args : []),
    '--cwd', resolvedCwd,
    '--raw',
    '--json-errors',
  ];

  let result: SpawnResultOutput;
  try {
    result = execTool(process.execPath, argv, { cwd: resolvedCwd, timeout });
  } catch (e) {
    // Defensive belt-and-suspenders: execTool is spawnSync-based and does not
    // throw today, but a degraded result here keeps this seam's no-throw
    // contract true even under an unanticipated future failure mode.
    return {
      ok: false,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
      code: null,
      timedOut: false,
    };
  }

  // Delegates to the single shared predicate defined above in this file
  // (#3050 — "Generative Fix Divergence") instead of a local inline copy.
  const timedOut = isSpawnTimeout(result);

  return {
    ok: result.exitCode === 0 && !timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.exitCode,
    timedOut,
  };
}

export function probeTty(opts: { platform?: string } = {}): string | null {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return null;
  try {
    const ttyPath = childProcess.execFileSync('tty', [], {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'ignore'],
    }).trim();
    if (!ttyPath || ttyPath === 'not a tty') return null;
    return ttyPath;
  } catch {
    return null;
  }
}

// ─── Platform file I/O ────────────────────────────────────────────────────────

function _normalizeMd(content: string): string {
  if (!content || typeof content !== 'string') return content;
  let text = content.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const result: string[] = [];
  const fenceRegex = /^```/;
  const insideFence = new Array<boolean>(lines.length);
  let fenceOpen = false;
  for (let i = 0; i < lines.length; i++) {
    if (fenceRegex.test(lines[i].trimEnd())) {
      if (fenceOpen) {
        insideFence[i] = false;
        fenceOpen = false;
      } else {
        insideFence[i] = false;
        fenceOpen = true;
      }
    } else {
      insideFence[i] = fenceOpen;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : '';
    const prevTrimmed = prev.trimEnd();
    const trimmed = line.trimEnd();
    const isFenceLine = fenceRegex.test(trimmed);
    if (/^#{1,6}\s/.test(trimmed) && i > 0 && prevTrimmed !== '' && prevTrimmed !== '---') result.push('');
    if (isFenceLine && i > 0 && prevTrimmed !== '' && !insideFence[i] && (i === 0 || !insideFence[i - 1] || isFenceLine)) {
      if (i === 0 || !insideFence[i - 1]) result.push('');
    }
    if (/^(\s*[-*+]\s|\s*\d+\.\s)/.test(line) && i > 0 && prevTrimmed !== '' && !/^(\s*[-*+]\s|\s*\d+\.\s)/.test(prev) && prevTrimmed !== '---') result.push('');
    result.push(line);
    if (/^#{1,6}\s/.test(trimmed) && i < lines.length - 1 && (lines[i + 1] ?? '').trimEnd() !== '') result.push('');
    if (/^```\s*$/.test(trimmed) && i > 0 && insideFence[i - 1] && i < lines.length - 1 && (lines[i + 1] ?? '').trimEnd() !== '') result.push('');
    if (/^(\s*[-*+]\s|\s*\d+\.\s)/.test(line) && i < lines.length - 1) {
      const next = lines[i + 1];
      if (next !== undefined && next.trimEnd() !== '' && !/^(\s*[-*+]\s|\s*\d+\.\s)/.test(next) && !/^\s/.test(next)) result.push('');
    }
  }
  text = result.join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\n*$/, '\n');
  return text;
}

export function normalizeContent(filePath: string, content: string, opts: { encoding?: BufferEncoding } = {}): { content: string; encoding: BufferEncoding } {
  const encoding = opts.encoding ?? 'utf-8';
  const isMd = path.extname(filePath).toLowerCase() === '.md';
  let normalized: string;
  if (isMd) {
    normalized = _normalizeMd(content);
  } else {
    normalized = (content ?? '').replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  }
  return { content: normalized, encoding };
}

// Rename errnos that are transient on Windows: a concurrent reader (or an AV
// scanner / indexer) holding the target open makes renameSync fail briefly.
// Same idiom as capability-ledger.cts / capability-consent.cts.
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 3;
const RENAME_RETRY_BACKOFF_MS = 50;

/** Synchronous best-effort backoff sleep (Atomics.wait — same idiom as io.cts). */
let _renameSleepBuf: Int32Array | null = null;
function renameBackoff(): void {
  if (_renameSleepBuf === null) _renameSleepBuf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(_renameSleepBuf, 0, 0, RENAME_RETRY_BACKOFF_MS);
}

/**
 * Atomic publish with bounded retry on transient Windows lock errnos.
 * Returns null on success, or the final error if every attempt failed.
 */
function atomicRenameWithRetry(tmpPath: string, filePath: string): NodeJS.ErrnoException | null {
  let renameErr: NodeJS.ErrnoException | null = null;
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return null;
    } catch (err) {
      renameErr = err as NodeJS.ErrnoException;
      if (attempt < RENAME_MAX_ATTEMPTS && RENAME_RETRY_ERRNOS.has(renameErr.code ?? '')) {
        renameBackoff();
        continue;
      }
      break;
    }
  }
  return renameErr;
}

/**
 * Drop-in replacement for `fs.renameSync(from, to)` that retries the transient
 * Windows lock errnos (EPERM/EBUSY/EACCES — see DEFECT.WINDOWS-FS-OPS) a bounded
 * number of times with a short backoff before rethrowing the final error.
 *
 * Idempotent on POSIX (the transient errnos do not occur), so callers retain
 * identical semantics on macOS/Linux while gaining resilience on Windows where
 * an antivirus scanner, indexer, or concurrent reader may briefly hold the
 * target open. Enforced by local/require-fs-op-fallback (ADR-1703 Phase 6).
 */
export function retryRenameSync(fromPath: string, toPath: string): void {
  const err = atomicRenameWithRetry(fromPath, toPath);
  if (err !== null) throw err;
}

export function platformWriteSync(filePath: string, content: string, opts: { encoding?: BufferEncoding } = {}): void {
  const { content: normalized, encoding } = normalizeContent(filePath, content, opts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;

  // Step 1: write the sibling tmp file. If THIS fails, nothing was published, so a
  // direct fallback write cannot truncate a concurrent reader of an existing file.
  try {
    fs.writeFileSync(tmpPath, normalized, encoding);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    fs.writeFileSync(filePath, normalized, encoding);
    return;
  }

  // Step 2: atomic publish, retrying transient Windows locks.
  const renameErr = atomicRenameWithRetry(tmpPath, filePath);
  if (renameErr === null) return;

  try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
  if (RENAME_RETRY_ERRNOS.has(renameErr.code ?? '')) {
    // A live reader still holds the target open after every retry. A non-atomic
    // direct write here would truncate that reader (the exact corruption this seam
    // exists to prevent), so surface the error instead of falling back.
    throw renameErr;
  }
  // Atomic publish is genuinely impossible here (e.g. EXDEV cross-device move):
  // fall back to a direct write to preserve write availability.
  fs.writeFileSync(filePath, normalized, encoding);
}

export function platformReadSync(filePath: string, opts: { encoding?: BufferEncoding; required?: boolean } = {}): string | null {
  const encoding = opts.encoding ?? 'utf-8';
  try {
    return fs.readFileSync(filePath, encoding);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      if (opts.required) throw err;
      return null;
    }
    throw err;
  }
}

export function platformEnsureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

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
import { escapeRegex } from './pattern.cjs';

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
 * #3663 — comparison key for a path that must equal another path regardless
 * of spelling: separator form (forward slashes via posixNormalize), relative
 * segments and trailing separators (path.resolve + strip), and — ONLY on
 * win32's case-insensitive filesystem — letter casing. POSIX stays
 * case-sensitive: differently-cased paths are genuinely different
 * directories there. This module owns the platform-conditional fold so the
 * policy lives at the seam instead of accreting per-call-site copies (the
 * class init.cts's normalizeForCompare/toComparableRaw predate).
 */
export function toComparablePathKey(p: string, platform: string = process.platform): string {
  const normalized = posixNormalize(path.resolve(p)).replace(/\/+$/g, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
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
    // #3662: the three PreToolUse guards are GSD-managed JS hooks (registered
    // only-if-absent by applySettingsJsonHooks) but sat outside this set, so
    // the #2979 runner rewriter never reached them — the issue's reported
    // mixed state lived on exactly these hooks.
    'gsd-write-guard.js',
    'gsd-agent-isolation-guard.js',
    'gsd-worktree-path-guard.js',
    // #4221: secret-file read guard (Read|Grep|Bash).
    'gsd-secret-read-guard.js',
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
    'gsd-graphify-update.sh',
    // #3662: same three guards as MANAGED_HOOK_BASENAMES_BY_SURFACE above —
    // their absence here meant isManagedHookCommand never recognized them, so
    // the settings.json→settings.local.json migration filter (and uninstall
    // cleanup) skipped GSD's own guard entries. Folded-in fix, surfaced by the
    // #3662 issue thread.
    'gsd-write-guard.js',
    'gsd-agent-isolation-guard.js',
    'gsd-worktree-path-guard.js',
    // #4221: secret-file read guard (Read|Grep|Bash).
    'gsd-secret-read-guard.js',
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
    const escapedBasename = escapeRegex(basename);
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
 *
 * #3662: `runnerToken` is the runner the current install would emit — since
 * #3662 that is the runtime-resolving chain token (see
 * buildNodeRunnerChainToken), not a bare absolute path, so re-projected
 * entries converge onto a runner that resolves in every environment sharing
 * the config root.
 */
export function projectLegacySettingsHookCommand({
  runnerToken,
  scriptPath,
  scriptToken,
  runtime = 'generic',
  platform = process.platform,
}: {
  runnerToken?: string | null;
  scriptPath?: string | null;
  scriptToken?: string | null;
  runtime?: string;
  platform?: string;
}): string | null {
  if (!runnerToken || !scriptPath) return null;
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
    runnerToken,
    argTokens: [commandScriptToken],
    runtime,
    platform,
  });
}

// Implements the TOML v1.0.0 basic-string escaping grammar (toml.md, "Basic
// strings" section, https://toml.io/en/v1.0.0#string): a basic string must
// escape the quotation mark, backslash, and control characters other than
// tab (U+0000-U+0008, U+000A-U+001F, U+007F). Compact escapes are used where
// TOML defines them (\b \t \n \f \r \" \\); every other character in the
// required ranges falls back to \uXXXX. See #3118 — an earlier version
// escaped only backslash and quote, so a raw newline/CR/NUL in a value
// produced an unparseable config.toml.
const TOML_COMPACT_ESCAPES: Record<string, string> = {
  '\x08': '\\b',
  '\x09': '\\t',
  '\x0A': '\\n',
  '\x0C': '\\f',
  '\x0D': '\\r',
};

// U+0000-U+0008, U+000A-U+001F, U+007F — control characters other than tab
// (U+0009), which the grammar permits unescaped.
const TOML_MUST_ESCAPE_CONTROL_CHARS = /[\x00-\x08\x0A-\x1F\x7F]/g;

export function escapeTomlDoubleQuotedString(value: unknown): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(TOML_MUST_ESCAPE_CONTROL_CHARS, (ch) => {
      const compact = TOML_COMPACT_ESCAPES[ch];
      if (compact) return compact;
      return `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`;
    });
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

/**
 * The `export PATH="<dir>:$PATH"` line every persistence lane appends, plus the escaped directory
 * token it embeds. One builder because three lanes emit this line: a lane that re-escapes it
 * locally is how #3118 shipped a `$(…)` into ~/.bashrc, where it ran on every new shell. The
 * escaping is for the line's FINAL context — a double-quoted string in an rc file — not for
 * whatever transport (an `echo`, a paste) it passes through on the way there.
 */
export function projectPathExportLine(targetDir: unknown): { escapedDir: string; line: string } {
  const escapedDir = escapePosixDoubleQuoted(String(targetDir));
  return { escapedDir, line: `export PATH="${escapedDir}:$PATH"` };
}

interface ShellAction {
  label: string | null;
  shell: string;
  command: string;
}

/**
 * Why a PATH suggestion produced no actions. An empty `shellActions` alone folds two different
 * facts together — "no target directory was given" and "this target directory cannot be
 * expressed as a shell command" — and a caller that cannot tell them apart prints a header with
 * nothing under it (#3118).
 */
export const PATH_ACTION_REASON = Object.freeze({
  NO_TARGET_DIR: 'no_target_dir',
  WIN32_RESERVED_QUOTE: 'win32_reserved_quote',
});

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
}): { shellActions: ShellAction[]; actionLines: string[]; reason?: string } {
  if (!targetDir) return { shellActions: [], actionLines: [], reason: PATH_ACTION_REASON.NO_TARGET_DIR };

  // #3118: `"` is reserved on Windows, so a path containing one cannot exist — and it would close
  // cmd's quoted region in the `powershell -Command "…"` lane below, turning the rest into cmd
  // input. There is no correct command to suggest for an impossible path: fail closed rather than
  // emit one whose quoting can be broken.
  if (platform === 'win32' && String(targetDir).includes('"')) return { shellActions: [], actionLines: [], reason: PATH_ACTION_REASON.WIN32_RESERVED_QUOTE };

  const isWin32 = platform === 'win32';

  let shellActions: ShellAction[];
  if (isWin32) {
    const psTargetDir = escapePowerShellSingleQuoted(targetDir);
    const bashExportLine = escapeSingleQuotedShellLiteral(
      projectPathExportLine(posixNormalize(String(targetDir))).line,
    );
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
        command: `echo '${bashExportLine}' >> ~/.bashrc`,
      },
    ];
  } else if (mode === 'persist') {
    const exportLine = escapeSingleQuotedShellLiteral(projectPathExportLine(targetDir).line);
    const fishTargetDir = escapeSingleQuotedShellLiteral(String(targetDir));
    shellActions = [
      {
        label: 'zsh',
        shell: 'zsh',
        command: `echo '${exportLine}' >> ~/.zshrc`,
      },
      {
        label: 'bash',
        shell: 'bash',
        command: `echo '${exportLine}' >> ~/.bashrc`,
      },
      // #323: fish has no `export`/`$PATH`-list syntax. `fish_add_path` is the
      // fish-native API (>= fish 3.2, 2021) that persists to the universal
      // variable store and de-duplicates. The directory is single-quoted with
      // the same POSIX literal escaping as the zsh/bash siblings — `'\''` is
      // also a valid escaped single quote in fish between quote spans.
      //
      // #3118 review MINOR: a `targetDir` with a leading `-` (e.g. `-v`) is a
      // legal directory name, but fish's argparse-based option scanning
      // treats a leading-dash token as a flag REGARDLESS of quoting, so
      // `fish_add_path '-v'` misparses it and prints "No paths to add, not
      // setting anything." (exit 1) instead of adding the path. `--` is
      // fish's standard end-of-options separator; verified empirically
      // against a real fish 4.8.1 install that `fish_add_path -- '-v'`
      // succeeds where the unseparated form fails.
      {
        label: 'fish',
        shell: 'fish',
        command: `fish_add_path -- '${fishTargetDir}'`,
      },
    ];
  } else {
    shellActions = [
      {
        label: null,
        shell: 'posix',
        command: projectPathExportLine(targetDir).line,
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
}): { shellActions: ShellAction[]; reason?: string } {
  const projected = projectPathActionProjection({
    mode: 'persist',
    targetDir,
    platform,
  });
  return projected.reason === undefined
    ? { shellActions: projected.shellActions }
    : { shellActions: projected.shellActions, reason: projected.reason };
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

/**
 * Default PATHEXT when Windows does not supply one. Matches the value
 * `gsd-tools.cjs`'s `resolveSpawnBinary` shipped in #3275; kept identical so the
 * delegation is a behavior-preserving move rather than a redefinition.
 */
const DEFAULT_PATHEXT = '.EXE;.CMD;.BAT;.COM';

/** Windows extensions that must be mediated through cmd.exe rather than spawned. */
const CMD_MEDIATED_EXT = /\.(cmd|bat)$/i;

function _isFile(candidate: string, requireExecutable = false, platform: string = process.platform): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (requireExecutable && platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    // Missing, unreadable (EACCES), a broken link, or (when requireExecutable
    // is set) not executable — all mean "not this one".
    return false;
  }
}

/**
 * Read an environment variable by name, case-insensitively.
 *
 * Windows environment variable names are case-insensitive and conventionally
 * cased `Path` / `ComSpec`, and `process.env` is a case-insensitive proxy that
 * hides the difference. Spreading it (`{ ...process.env, ...opts.env }`, which
 * `execTool` does whenever a caller supplies `opts.env`) produces a PLAIN object
 * that keeps the OS's actual casing and loses the proxy — so an exact-case
 * `env['PATH']` lookup returns undefined there and the PATH scan silently sees
 * nothing. Caught by the Windows CI lane on #3617; the #3445 tests never hit it
 * because they pass uppercase keys explicitly.
 *
 * Exact match wins when present, so a caller who sets the canonical name pays
 * no scan.
 *
 * Exported so callers outside this seam can route an exact-case-sensitive env
 * read through it instead of accessing a non-`process.env` object directly
 * (see `local/no-exact-case-env-access`).
 */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

/** cmd.exe's own quoting rule inside a `/c` string: a literal quote is doubled. */
function _cmdQuoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Build a single verbatim command-line string for `cmd.exe /c` where every
 * token is force-quoted, then wrap the whole thing in one more outer pair.
 * cmd.exe strips exactly one outer quote pair when the string begins with a
 * quote and contains at least two — so the outer wrap disappears and what's
 * left is a sequence of individually-quoted tokens. Force-quoting is the
 * point: an unquoted `a&b` is split by cmd's own metacharacter parsing, but a
 * quoted `"a&b"` is one literal argument.
 */
function _buildVerbatimCmdLine(target: string, args: string[]): string {
  return `"${[target, ...args].map(_cmdQuoteToken).join(' ')}"`;
}

/**
 * #3411: resolve a DECLARED command name to the file a spawn can actually start.
 * The single canonical answer to "where is this binary?" for the whole tree.
 *
 * This is the seam `CONTEXT.md` declares as "All OS-facing I/O; single platform
 * seam". Four divergent implementations of this logic existed (#3411): `execNpm`'s
 * `shell:true`, `execTool`'s absence of any handling, `gsd-tools.cjs`'s private
 * scan, and `fallow-runner.cts`'s own candidate array. #3275 folded two of them
 * together in `bin/`; this lifts that resolver into the seam so `bin/` delegates
 * instead of owning a copy.
 *
 * **win32** tries PATHEXT entries ONLY — never the bare name. npm global installs
 * drop an EXTENSIONLESS POSIX sh shim (`...\npm\codex`) next to `codex.CMD`; a
 * bare-name-first scan resolves to it, the cmd.exe mediation gate sees no `.cmd`,
 * and the ENOENT returns unchanged (field-reported on Windows 11 — see #3275).
 * A name that ALREADY carries a PATHEXT-listed extension is tried as-is first, so
 * `foo.exe` resolves to `foo.exe` rather than being probed as `foo.exe.EXE`; a
 * suffix that is not in PATHEXT (`foo.txt`) is not an extension and only feeds the
 * append loop.
 *
 * **POSIX** answers EXISTENCE by scanning PATH for the bare name. `execTool` does
 * NOT consult this on POSIX — the bare name goes to spawnSync unchanged and Node's
 * own PATH search does the work, so macOS/Linux behavior is untouched (#3275
 * acceptance contract).
 *
 * Path-like names (any `/` or `\`) bypass the PATH scan: the name is already an
 * address, so it passes through when it names an existing file.
 *
 * **`opts.prependPaths`** — directories searched BEFORE `env.PATH`, in array
 * order (e.g. a project-local `node_modules/.bin`). Defaults to `[]`, so
 * Phase 1's callers (`execTool`, and `gsd-tools.cjs`'s `resolveSpawnBinary` /
 * `deps.spawn` / `hasBinary`), which set neither new option, are byte-identical
 * to today. The existing per-directory candidate logic (win32 as-is-then-append-
 * PATHEXT; POSIX bare name) applies to prepended directories exactly as it does
 * to `PATH` segments — there is no special-casing.
 *
 * **`opts.requireExecutable`** — when `true` and the platform is not `win32`,
 * a candidate must additionally pass `fs.accessSync(candidate, fs.constants.X_OK)`
 * to count as a match. On `win32` this is a no-op (mode bits do not mean
 * execute on Windows — the same carve-out `fallow-runner`'s prior private
 * resolver already had). Defaults to `false`, so `accessSync` is never called
 * unless a caller opts in. It is opt-in rather than the default because making
 * `X_OK` unconditional would break #3445's suite: those tests stage candidates
 * with plain `fs.writeFileSync` and never set an exec bit (the repo bans
 * `chmod` in tests), so every one of them would resolve to `null` on POSIX.
 *
 * **`opts.pathOverride`** — "search THIS PATH, but read everything else —
 * PATHEXT included — from the ambient environment." When set (`!== undefined`),
 * the PATH search segments come from splitting `pathOverride` on `path.delimiter`
 * instead of from `env.PATH`; `pathOverride: ''` means an explicit EMPTY search
 * path (zero segments), never a fallback to `env.PATH` — use `!== undefined`,
 * not truthiness, to tell "caller supplied a PATH string" apart from "caller
 * supplied nothing". `opts.prependPaths` still comes first. PATHEXT resolution
 * is UNAFFECTED by this option — it still reads from `env` (which defaults to
 * `process.env`) exactly as it does when `pathOverride` is omitted. This exists
 * so a caller that already has its own search path in hand (e.g.
 * `resolveFallowBinary`'s `envPath`) does not have to hand-thread PATHEXT
 * alongside it — a private PATHEXT read is the very shape
 * `local/no-private-binary-resolution` forbids outside this seam.
 *
 * @returns the resolved path, or `null` when nothing matched. Callers fall back to
 *   the declared name on `null` so a genuine ENOENT still surfaces (#3086).
 */
export function resolveExecutableBinary(
  name: string | null | undefined,
  opts: { platform?: string; env?: NodeJS.ProcessEnv; prependPaths?: string[]; requireExecutable?: boolean; pathOverride?: string } = {},
): string | null {
  if (!name) return null;
  const requireExecutable = opts.requireExecutable ?? false;
  const platform = opts.platform ?? process.platform;
  if (name.includes('/') || name.includes('\\')) {
    return _isFile(name, requireExecutable, platform) ? name : null;
  }
  const env = opts.env ?? process.env;
  const rawPath = opts.pathOverride !== undefined ? opts.pathOverride : (envGet(env, 'PATH') || '');
  const pathSegments = String(rawPath).split(path.delimiter).filter(Boolean);
  const segments = [...(opts.prependPaths ?? []), ...pathSegments];

  if (platform !== 'win32') {
    for (const dir of segments) {
      const candidate = path.join(dir, name);
      if (_isFile(candidate, requireExecutable, platform)) return candidate;
    }
    return null;
  }

  const exts = String(envGet(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').filter(Boolean);
  // A name already ending in a PATHEXT-listed extension is an address, not a stem:
  // probing `foo.exe` as `foo.exe.EXE` would miss the file sitting right there.
  // Compared case-insensitively because PATHEXT casing is not guaranteed.
  const lower = name.toLowerCase();
  const carriesKnownExt = exts.some((ext) => lower.endsWith(ext.toLowerCase()));

  for (const dir of segments) {
    if (carriesKnownExt) {
      const asIs = path.join(dir, name);
      if (_isFile(asIs, requireExecutable, platform)) return asIs;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (_isFile(candidate, requireExecutable, platform)) return candidate;
    }
  }
  return null;
}

/**
 * #3411: project a declared `(command, args)` into the pair `spawnSync` can
 * actually execute on this platform.
 *
 * Resolution alone does not make Windows work: `CreateProcess` cannot execute a
 * `.cmd`/`.bat` at all, so the cmd.exe mediation is inseparable from the lookup.
 * Exporting only the resolver would leave every caller to re-derive that half —
 * which is precisely how #3411's four copies accumulated.
 *
 * cmd.exe is invoked as an ordinary program with an EXPLICIT argv array, never via
 * `shell: true`. `shell:true` on Windows is the mechanism behind CVE-2024-27980
 * (argument injection through `.bat`/`.cmd`), and Node 26 deprecates it with an
 * args array (DEP0190) because arguments are concatenated rather than escaped.
 *
 * Mediation fires when the target — the resolved path, or the declared name when
 * resolution found nothing — carries a `.cmd`/`.bat` extension. A BARE name that
 * resolved to nothing is passed through verbatim so the spawn fails with ENOENT;
 * mediating it would turn `{exitCode:127, 'foo: not found'}` into cmd.exe's exit
 * 9009 and silently change the not-found contract callers depend on.
 *
 * POSIX is a strict no-op: the declared command is returned unchanged and the
 * environment is never consulted.
 *
 * The mediated command line is built VERBATIM rather than left to libuv: libuv's
 * `quote_cmd_arg` only force-quotes an argument that contains a space, tab, or
 * quote — it does not know about cmd.exe metacharacters (`&`, `|`, `>`, `<`,
 * `^`, ...) at all, so an argument like `a&calc` reaches cmd.exe unquoted and
 * gets re-parsed as two commands (the CVE-2024-27980 argument-injection class).
 * Node's own CVE-2024-27980 escaping does not help here because it only fires
 * when the spawned FILE itself is a `.bat`/`.cmd` — in this seam the spawned
 * file is `cmd.exe`, not the target. Building the line ourselves and passing
 * `windowsVerbatimArguments: true` (the shape Rust's std uses for the sibling
 * CVE-2024-24576) means every token is force-quoted inside one outer pair, so
 * a metacharacter inside a quoted token can never split the command line.
 *
 * KNOWN LIMIT: `%VAR%` still expands inside a cmd `/c` string, and there is no
 * escape for `%` outside a batch file — an argument containing `%FOO%` is
 * substituted with the environment value regardless of quoting. That is an
 * information-disclosure limit, not arbitrary execution, and it's the same
 * limit Rust's std documents for its own `CommandExt::raw_arg` escape hatch.
 *
 * CALLER CHOICE: this function's return value carries two independently
 * adoptable pieces of information, and a caller may take either, both, or
 * neither. `windowsVerbatimArguments: true` marks the cases where mediation
 * was REQUIRED — the caller MUST adopt `command`+`args` together, since a
 * `.cmd`/`.bat` genuinely cannot be spawned any other way. A merely-resolved
 * `.exe` path (no mediation flag set) is only an OFFER: a caller may decline
 * it and keep spawning the declared name instead, to hold its own observable
 * contract stable. `execTool` (this file, below) is exactly such a caller —
 * it adopts the mediated pair when `windowsVerbatimArguments` is set, but
 * otherwise passes the declared `program`/`args` through untouched.
 */
export function projectSpawnInvocation(
  command: string,
  args: string[] = [],
  opts: { platform?: string; env?: NodeJS.ProcessEnv } = {},
): { command: string; args: string[]; resolved: string | null; windowsVerbatimArguments?: boolean } {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { command, args, resolved: null };

  const env = opts.env ?? process.env;
  const resolved = resolveExecutableBinary(command, { platform, env });
  // Mediate against the resolved path when we have one, else against the declared
  // name. An unresolved name is mediated ONLY when it already declares .cmd/.bat:
  // PATH-only resolution misses a batch file sitting in the current directory,
  // which `cmd.exe /c` still finds — the behavior gsd-tools.cjs shipped before
  // this consolidation, preserved here rather than silently narrowed.
  const target = resolved ?? command;
  if (!CMD_MEDIATED_EXT.test(path.basename(target))) {
    // A BARE name that resolved to nothing is passed through untouched so the
    // spawn fails with ENOENT. Mediating it would turn {exitCode:127,
    // '<name>: not found'} into cmd.exe's exit 9009 and silently change the
    // not-found contract `_spawnResult` and its 53 dependent files rely on.
    return resolved ? { command: resolved, args, resolved } : { command, args, resolved: null };
  }
  // A CR/LF cannot be represented inside a Windows command line at all — cmd.exe
  // treats it as a line terminator, so mediating it would silently truncate the
  // argument rather than pass it through. Fail visibly instead: fall back to the
  // unmediated shape so the spawn either fails with ENOENT (bare unresolved name)
  // or hands the raw string to CreateProcess, whichever the caller was already
  // prepared to see for a non-.cmd/.bat target.
  if (/[\r\n]/.test(target) || args.some((a) => /[\r\n]/.test(a))) {
    return resolved ? { command: resolved, args, resolved } : { command, args, resolved: null };
  }
  return {
    command: String(envGet(env, 'ComSpec') || 'cmd.exe'),
    args: ['/d', '/s', '/c', _buildVerbatimCmdLine(target, args)],
    resolved,
    windowsVerbatimArguments: true,
  };
}

export function execTool(program: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): SpawnResultOutput {
  // #3411: Windows cannot spawn a .cmd/.bat at all — CreateProcess refuses it —
  // so those are mediated through cmd.exe. Everything else keeps the DECLARED
  // program name: libuv's CreateProcess path already performs PATH + PATHEXT
  // search, so resolving a .exe here would buy nothing and would change what
  // this seam's 167 dependents observe being spawned. `tests/graphify.test.cjs`
  // pins that contract by spying on spawnSync's first argument. POSIX never
  // reaches the mediation branch at all.
  const spawnEnv = opts.env ? { ...process.env, ...opts.env } : undefined;
  const invocation = projectSpawnInvocation(program, args, { env: spawnEnv ?? process.env });
  const mediated = invocation.windowsVerbatimArguments === true;
  const result = childProcess.spawnSync(mediated ? invocation.command : program, mediated ? invocation.args : args, {
    cwd: opts.cwd,
    env: spawnEnv,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
    windowsHide: true,
    ...(mediated ? { windowsVerbatimArguments: true } : {}),
  });
  // Stamp the DECLARED name, never the resolved path: `_spawnResult` renders
  // `${program}: not found`, and callers across 53 files match on the string they
  // passed. Resolution must not leak an absolute path into that message.
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
      timeout: 5_000,
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
    // #3854: the `!/^\s/.test(prev)` guard mirrors the after-a-bullet rule below —
    // an indented non-bullet line is a CONTINUATION of the previous list item, not a
    // preceding paragraph, so no separating blank may be injected before this bullet
    // (that injection converted every tight multi-line list to a loose one on write).
    if (/^(\s*[-*+]\s|\s*\d+\.\s)/.test(line) && i > 0 && prevTrimmed !== '' && !/^(\s*[-*+]\s|\s*\d+\.\s)/.test(prev) && !/^\s/.test(prev) && prevTrimmed !== '---') result.push('');
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

/**
 * True iff persisting `after` via `platformWriteSync` would land different
 * on-disk bytes than `before` already has (or would have, normalized the
 * same way). `platformWriteSync` runs Markdown normalization (CRLF strip,
 * blank-line-run collapse, single trailing newline) before writing, so a
 * caller comparing raw pre-normalize strings (`after !== before`) can report
 * `true` even when the persisted bytes are byte-identical — e.g. a
 * transform that regenerates a section fresh on every call, including a
 * genuine no-op re-run, in a different-but-equivalent raw shape than the
 * already-normalized on-disk original (#3685 / #3691). Any "did this write
 * change the file?" flag MUST go through this seam (or an equivalent
 * post-write re-read of the actual on-disk bytes) instead of a raw `!==` —
 * do not simplify this back to a direct string comparison.
 */
export function contentChangedAfterNormalize(filePath: string, before: string, after: string): boolean {
  return normalizeContent(filePath, after).content !== normalizeContent(filePath, before).content;
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

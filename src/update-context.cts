/**
 * Update-context resolver (issue #498, candidate 3).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/update-context.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */

import path from 'node:path';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';

/** Runtime → candidate relative dir pairs. */
export type RuntimeDirEntry = [string, string];

// Runtime -> candidate relative dir. Order matters: it is the probe order, and
// mirrors the RUNTIME_DIRS array the bash used (a runtime may have several
// candidate dirs). Kept here, not derived from the installer's getDirName,
// because update detection probes ALL historical dirs per runtime.
export const RUNTIME_DIRS: RuntimeDirEntry[] = [
  ['claude', '.claude'],
  ['opencode', '.config/opencode'],
  ['opencode', '.opencode'],
  ['antigravity', '.gemini/antigravity-ide'],
  ['antigravity', '.gemini/antigravity-cli'],
  ['antigravity', '.gemini/antigravity'],
  ['antigravity', '.agents'], // local Antigravity install dir canonical (#791; bin/install.js getDirName('antigravity'))
  ['antigravity', '.agent'], // local Antigravity install dir legacy (#503; backward-compat with pre-#791 installs)
  ['windsurf', '.windsurf'], // local Windsurf workflow dir canonical (#1615; bin/install.js getDirName('windsurf'))
  ['windsurf', '.devin'],    // local Devin Desktop install dir legacy (#1085; backward-compat)
  ['kilo', '.config/kilo'],
  ['kilo', '.kilo'],
  ['codex', '.codex'],
];

const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;

// Shared Codex config-root marker filename. Single-sourced here (this module
// is the pre-existing, dependency-free owner) and re-exported by
// host-runtime-detection.cts, whose detection rung reuses this exact probe
// filename (though NOT the truthiness rule below — see that module's header
// comment for the deliberate divergence).
export const CODEX_CONFIG_MARKER = 'config.toml';

function expandHome(p: string | undefined | null, home: string): string {
  if (!p) return '';
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function versionFile(dir: string): string { return path.join(dir, 'gsd-core', 'VERSION'); }
function markerFile(dir: string): string { return path.join(dir, 'gsd-core', 'workflows', 'update.md'); }

export interface FsAdapter {
  exists(p: string): boolean;
  readFile(p: string): string | null;
}

// Detection: a dir "has GSD" if it carries a VERSION file or the update.md
// workflow marker.
function hasInstall(fs: FsAdapter, dir: string): boolean {
  return fs.exists(versionFile(dir)) || fs.exists(markerFile(dir));
}

// Read VERSION at dir; return a trimmed semver string, or null if missing/invalid.
function validVersionAt(fs: FsAdapter, dir: string): string | null {
  const raw = fs.readFile(versionFile(dir));
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return SEMVER_PREFIX.test(trimmed) ? trimmed : null;
}

// A version is TRUSTED only when BOTH the VERSION file and the update.md marker
// exist (and VERSION is valid semver).
function trustedVersionAt(fs: FsAdapter, dir: string | undefined): string | null {
  return dir && fs.exists(markerFile(dir)) ? validVersionAt(fs, dir) : null;
}

export interface InferPreferredRuntimeOpts {
  fs: FsAdapter;
  env: Record<string, string | undefined>;
  preferredConfigDir: string;
}

// Infer the preferred runtime from preferredConfigDir config files, then env.
export function inferPreferredRuntime({ fs, env, preferredConfigDir }: InferPreferredRuntimeOpts): string {
  if (preferredConfigDir) {
    if (fs.exists(path.join(preferredConfigDir, 'kilo.json')) ||
        fs.exists(path.join(preferredConfigDir, 'kilo.jsonc'))) return 'kilo';
    if (fs.exists(path.join(preferredConfigDir, 'opencode.json')) ||
        fs.exists(path.join(preferredConfigDir, 'opencode.jsonc'))) return 'opencode';
    if (fs.exists(path.join(preferredConfigDir, CODEX_CONFIG_MARKER))) return 'codex';
    const resolved = path.resolve(preferredConfigDir);
    const known = RUNTIME_DIRS.find(([, reldir]) =>
      resolved.endsWith(path.sep + reldir.split('/').join(path.sep)));
    if (known) return known[0];
  }
  if (env['CODEX_HOME']) return 'codex';
  if (env['ANTIGRAVITY_CONFIG_DIR']) return 'antigravity';
  if (env['KILO_CONFIG_DIR'] || env['KILO_CONFIG']) return 'kilo';
  if (env['OPENCODE_CONFIG_DIR'] || env['OPENCODE_CONFIG']) return 'opencode';
  if (env['CLAUDE_CONFIG_DIR']) return 'claude';
  return '';
}

export interface EnvRuntimeDirsOpts {
  env: Record<string, string | undefined>;
  home: string;
}

// Absolute env-override candidates, mirroring the bash ENV_RUNTIME_DIRS block.
export function envRuntimeDirs({ env, home }: EnvRuntimeDirsOpts): RuntimeDirEntry[] {
  const out: RuntimeDirEntry[] = [];
  const ex = (v: string | undefined) => expandHome(v, home);
  if (env['CLAUDE_CONFIG_DIR']) out.push(['claude', ex(env['CLAUDE_CONFIG_DIR'])]);
  if (env['ANTIGRAVITY_CONFIG_DIR']) out.push(['antigravity', ex(env['ANTIGRAVITY_CONFIG_DIR'])]);
  if (env['KILO_CONFIG_DIR']) out.push(['kilo', ex(env['KILO_CONFIG_DIR'])]);
  else if (env['KILO_CONFIG']) out.push(['kilo', path.dirname(ex(env['KILO_CONFIG']))]);
  else if (env['XDG_CONFIG_HOME']) out.push(['kilo', path.join(ex(env['XDG_CONFIG_HOME']), 'kilo')]);
  if (env['OPENCODE_CONFIG_DIR']) out.push(['opencode', ex(env['OPENCODE_CONFIG_DIR'])]);
  else if (env['OPENCODE_CONFIG']) out.push(['opencode', path.dirname(ex(env['OPENCODE_CONFIG']))]);
  else if (env['XDG_CONFIG_HOME']) out.push(['opencode', path.join(ex(env['XDG_CONFIG_HOME']), 'opencode')]);
  if (env['CODEX_HOME']) out.push(['codex', ex(env['CODEX_HOME'])]);
  return out;
}

// Stable reorder: entries whose runtime === preferred first, original order kept.
function preferFirst(entries: RuntimeDirEntry[], preferred: string): RuntimeDirEntry[] {
  const pref = entries.filter(([rt]) => rt === preferred);
  const rest = entries.filter(([rt]) => rt !== preferred);
  return [...pref, ...rest];
}

// GLOBAL probe: absolute env candidates first (in preferFirst order, first
// hasInstall hit wins), then $HOME-relative. Single resolver shared by the
// preferredConfigDir fast path's same-path dedup and the full cascade (#4197),
// so both compare against the global dir the resolution would actually select —
// an env-directed candidate, not necessarily the $HOME-relative pathname.
function resolveGlobalCandidate(
  fs: FsAdapter,
  env: Record<string, string | undefined>,
  home: string,
  preferred: string,
): { runtime: string; dir: string } {
  for (const [rt, absdir] of preferFirst(envRuntimeDirs({ env, home }), preferred)) {
    if (hasInstall(fs, absdir)) return { runtime: rt, dir: path.resolve(absdir) };
  }
  for (const [rt, reldir] of preferFirst(RUNTIME_DIRS, preferred)) {
    const cand = path.resolve(home, reldir);
    if (hasInstall(fs, cand)) return { runtime: rt, dir: cand };
  }
  return { runtime: '', dir: '' };
}

export interface ResolveUpdateContextOpts {
  home: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  fs: FsAdapter;
  preferredConfigDir?: string;
  preferredRuntime?: string;
}

export interface UpdateContext {
  installedVersion: string;
  scope: 'LOCAL' | 'GLOBAL' | 'UNKNOWN';
  runtime: string;
  gsdDir: string;
}

/**
 * Pure resolver. Returns { installedVersion, scope, runtime, gsdDir }.
 */
export function resolveUpdateContext({
  home,
  cwd,
  env = {},
  fs,
  preferredConfigDir = '',
  preferredRuntime = '',
}: ResolveUpdateContextOpts): UpdateContext {
  // Expand a leading `~/` before any probe.
  preferredConfigDir = expandHome(preferredConfigDir, home);
  const preferred = preferredRuntime || inferPreferredRuntime({ fs, env, preferredConfigDir });

  // Fast path: a validated preferredConfigDir (custom --config-dir install).
  if (preferredConfigDir && hasInstall(fs, preferredConfigDir)) {
    const resolvedPref = path.resolve(preferredConfigDir);
    // Same-path dedup the cascade applies (#4197): a preferred dir that IS the
    // selected global install (an env candidate or the $HOME-relative dir) is
    // GLOBAL even when cwd === $HOME also makes it the cwd-relative match.
    const { dir: globalDir } = resolveGlobalCandidate(fs, env, home, preferred);
    let scope: 'LOCAL' | 'GLOBAL' = 'GLOBAL';
    if (resolvedPref !== globalDir) {
      for (const [, reldir] of RUNTIME_DIRS) {
        if (path.resolve(cwd, reldir) === resolvedPref) { scope = 'LOCAL'; break; }
      }
    }
    return {
      installedVersion: trustedVersionAt(fs, preferredConfigDir) ?? '0.0.0',
      scope,
      runtime: preferred,
      gsdDir: preferredConfigDir,
    };
  }

  const orderedRuntime = preferFirst(RUNTIME_DIRS, preferred);

  // LOCAL probe (relative to cwd).
  let localRuntime = '', localDir = '';
  for (const [rt, reldir] of orderedRuntime) {
    const cand = path.resolve(cwd, reldir);
    if (hasInstall(fs, cand)) { localRuntime = rt; localDir = cand; break; }
  }

  // GLOBAL probe: absolute env candidates first, then $HOME-relative — the
  // same resolver the fast path dedups against.
  const { runtime: globalRuntime, dir: globalDir } = resolveGlobalCandidate(fs, env, home, preferred);

  const localValid = trustedVersionAt(fs, localDir);
  const isLocal = !!localValid && (!globalDir || localDir !== globalDir);

  if (isLocal) {
    return { installedVersion: localValid, scope: 'LOCAL', runtime: localRuntime, gsdDir: localDir };
  }
  const globalValid = trustedVersionAt(fs, globalDir);
  if (globalValid) {
    return { installedVersion: globalValid, scope: 'GLOBAL', runtime: globalRuntime, gsdDir: globalDir };
  }
  // A runtime dir was detected (VERSION or marker present) but is not a
  // complete, valid install: keep scope/runtime/dir and report 0.0.0 so the
  // caller re-installs.
  if (localRuntime && (!globalDir || localDir !== globalDir)) {
    return { installedVersion: '0.0.0', scope: 'LOCAL', runtime: localRuntime, gsdDir: localDir };
  }
  if (globalRuntime) {
    return { installedVersion: '0.0.0', scope: 'GLOBAL', runtime: globalRuntime, gsdDir: globalDir };
  }
  return { installedVersion: '0.0.0', scope: 'UNKNOWN', runtime: '', gsdDir: '' };
}

export interface LoadUpdateContextOpts {
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  preferredConfigDir?: string;
  preferredRuntime?: string;
}

/**
 * CLI wiring: resolve against the real filesystem.
 */
export function loadUpdateContext(opts: LoadUpdateContextOpts = {}): UpdateContext {
  const fs: FsAdapter = {
    exists: (p: string) => nodeFs.existsSync(p),
    readFile: (p: string) => { try { return nodeFs.readFileSync(p, 'utf8'); } catch { return null; } },
  };
  return resolveUpdateContext({
    home: opts.home ?? nodeOs.homedir(),
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    fs,
    preferredConfigDir: opts.preferredConfigDir ?? '',
    preferredRuntime: opts.preferredRuntime ?? '',
  });
}
